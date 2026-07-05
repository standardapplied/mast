//! The in-process SSH backend that makes Mast a thin client on mobile as well
//! as desktop. Every capability the app needs — HTTP to the control plane, an
//! interactive terminal, (later) SFTP file transfer — rides one russh session
//! to the devbox, with no `ssh` subprocess. That is the whole reason for the
//! Tauri pivot: a spawned binary can't run inside the iOS/Android sandbox, but
//! this library can.
//!
//! Proven feasible in `spike/russh-proof` against a live sshd; this is the same
//! russh 0.45 API wired behind Tauri commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Config, Handle, Handler, Msg};
use russh::keys::agent::client::AgentClient;
use russh::keys::key;
use russh::keys::load_secret_key;
use russh::{Channel, ChannelMsg, ChannelStream};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no ~/.sail/config.yaml — run `sail host config` or log in first")]
    NoConfig,
    #[error("config is missing `{0}`")]
    MissingField(&'static str),
    #[error("no SSH key available — nothing in the ssh-agent and no readable key file (~/.ssh/id_ed25519|ecdsa|rsa). Run `ssh-add`, or point IdentityFile at an unencrypted key.")]
    NoKey,
    #[error("publickey auth rejected for {0}")]
    AuthRejected(String),
    #[error("timed out reaching {0} — check the host/ProxyJump in ~/.ssh/config")]
    Timeout(String),
    #[error("malformed HTTP response from the control plane")]
    BadResponse,
    #[error("no terminal with id {0}")]
    NoTerminal(String),
    #[error("sftp: {0}")]
    Sftp(String),
    #[error(transparent)]
    Ssh(#[from] russh::Error),
    #[error(transparent)]
    Keys(#[from] russh::keys::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl From<Error> for String {
    fn from(e: Error) -> String {
        e.to_string()
    }
}

/// Resolved connection facts, mirroring the `sail` CLI's `~/.sail/config.yaml`:
/// the SSH hop to the devbox (`host` is an ssh alias, resolved through
/// `~/.ssh/config`) and the loopback address the control plane listens on there.
#[derive(Clone, Debug)]
pub struct SailConfig {
    pub ssh_host: String,
    pub fallback_user: Option<String>,
    pub server_host: String,
    pub server_port: u16,
    pub token: Option<String>,
    pub key_path: Option<String>,
}

impl SailConfig {
    pub fn load() -> Result<Self, Error> {
        let home = dirs::home_dir().ok_or(Error::NoConfig)?;
        let raw = std::fs::read_to_string(home.join(".sail/config.yaml")).map_err(|_| Error::NoConfig)?;
        let map = parse_yaml(&raw);

        let ssh_host = map.get("host").cloned().ok_or(Error::MissingField("host"))?;
        let server = map
            .get("server")
            .cloned()
            .unwrap_or_else(|| "http://127.0.0.1:7070".into());
        let (server_host, server_port) = parse_server(&server);

        Ok(SailConfig {
            ssh_host,
            fallback_user: map.get("user").cloned(),
            server_host,
            server_port,
            token: map.get("token").cloned().filter(|t| !t.trim().is_empty()),
            key_path: map.get("key").cloned(),
        })
    }
}

/// One resolved SSH hop from `~/.ssh/config` (the alias merged with any matching
/// `Host` blocks). `hostname` defaults to the alias; unresolved user falls back
/// to the local `$USER`.
#[derive(Clone, Debug, Default)]
struct SshHost {
    hostname: String,
    user: Option<String>,
    port: u16,
    identity_files: Vec<PathBuf>,
    proxy_jump: Option<String>,
}

/// A live session to the devbox, plus every jump-host handle it rides through.
/// The jumps MUST stay alive: dropping one closes its channel, which is the
/// transport under the next hop's session.
struct Session {
    handle: Handle<Client>,
    #[allow(dead_code)]
    jumps: Vec<Handle<Client>>,
}

/// Accepts the devbox host key. Mast trusts the SSH hop the same way the `sail`
/// CLI does — the tunnel target is pinned by the user's own config, and a
/// known-hosts prompt has no UI on mobile. Host-key pinning is a follow-up.
struct Client;

#[async_trait]
impl Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _key: &key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

enum TermCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// One lazily-connected russh session, shared by the HTTP proxy and every
/// terminal. Held in Tauri managed state.
pub struct Backend {
    config: SailConfig,
    session: Mutex<Option<Session>>,
    /// One cached SSH session per project container (keyed by ssh alias), shared
    /// by that container's terminals and SFTP channels — one connection, many
    /// multiplexed channels. Evicted and redialed if it dies.
    containers: Mutex<HashMap<String, Arc<Session>>>,
    terminals: Mutex<HashMap<String, mpsc::Sender<TermCmd>>>,
}

#[derive(Serialize)]
pub struct SailResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub body: String,
}

/// One entry in a container directory listing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// A directory listing plus the absolute path it resolved to (so the client can
/// default uploads/refreshes to it).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

/// Live progress for a file transfer, emitted on the `transfer` event so the UI
/// can show a real bar while bytes crawl over a high-latency link.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub id: String,
    pub kind: &'static str,
    pub label: String,
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub status: &'static str,
    pub detail: Option<String>,
}

impl TransferProgress {
    fn start(id: String, kind: &'static str, label: String, files_total: u64, bytes_total: u64) -> Self {
        TransferProgress {
            id,
            kind,
            label,
            files_done: 0,
            files_total,
            bytes_done: 0,
            bytes_total,
            status: "active",
            detail: None,
        }
    }
}

struct UploadItem {
    local: PathBuf,
    remote: String,
}
#[derive(Default)]
struct UploadPlan {
    dirs: Vec<String>,
    files: Vec<UploadItem>,
    bytes: u64,
}

struct DownloadItem {
    remote: String,
    local: PathBuf,
}
#[derive(Default)]
struct DownloadPlan {
    files: Vec<DownloadItem>,
    bytes: u64,
}

const CHUNK: usize = 64 * 1024;
const EMIT_EVERY: u64 = 256 * 1024;

fn emit_transfer(app: &AppHandle, progress: &TransferProgress) {
    let _ = app.emit("transfer", progress);
}

impl Backend {
    pub fn new() -> Result<Self, Error> {
        Ok(Backend {
            config: SailConfig::load()?,
            session: Mutex::new(None),
            containers: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
        })
    }

    pub fn describe(&self) -> &SailConfig {
        &self.config
    }

    /// The project containers reachable from `~/.ssh/config`: concrete `Host`
    /// aliases that have a `ProxyJump` (the node hops to the container), which
    /// distinguishes them from the node/bastion aliases. `sail connect <project>`
    /// writes exactly these blocks (Host = project name). The iOS-portable path
    /// (no local ssh config) will instead source this list from the control
    /// plane once sail exposes a connect endpoint.
    pub fn list_targets(&self) -> Vec<String> {
        let cfg = read_ssh_config();
        let mut seen = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for line in cfg.lines() {
            let (keyword, value) = split_kv(line.trim());
            if !keyword.eq_ignore_ascii_case("host") {
                continue;
            }
            for pat in value.split_whitespace() {
                if pat.contains('*') || pat.contains('?') || pat.starts_with('!') {
                    continue;
                }
                if seen.insert(pat.to_string()) && resolve_host(pat, &cfg).proxy_jump.is_some() {
                    out.push(pat.to_string());
                }
            }
        }
        out
    }

    /// Actively establish the session (idempotent). The connection banner calls
    /// this so `phase` can reach `ready` — otherwise nothing dials until a board
    /// request, and the board is itself gated on `ready`.
    pub async fn connect(&self) -> Result<(), Error> {
        self.ensure().await
    }

    /// Dials the devbox, chaining through every `ProxyJump` hop resolved from
    /// `~/.ssh/config`: connect hop 1 directly, forward a channel to hop 2 and
    /// run SSH over it, and so on, until the target session rides the last hop.
    async fn dial(&self) -> Result<Session, Error> {
        self.dial_alias(&self.config.ssh_host, self.config.fallback_user.clone())
            .await
    }

    /// Dial any ssh alias (a project container as well as the node), resolving
    /// its `~/.ssh/config` entry + ProxyJump chain the same way.
    async fn dial_alias(&self, alias: &str, user_fallback: Option<String>) -> Result<Session, Error> {
        let cfg_text = read_ssh_config();
        let mut target = resolve_host(alias, &cfg_text);
        if target.user.is_none() {
            target.user = user_fallback;
        }
        let hops = build_hops(&target, &cfg_text);
        let ssh_cfg = Arc::new(Config::default());

        let mut jumps: Vec<Handle<Client>> = Vec::new();
        let mut carried: Option<ChannelStream<Msg>> = None;

        for (i, hop) in hops.iter().enumerate() {
            let next = hops.get(i + 1).unwrap_or(&target);
            let handle = self.handshake(ssh_cfg.clone(), carried.take(), hop).await?;
            let channel = handle
                .channel_open_direct_tcpip(next.hostname.as_str(), next.port as u32, "127.0.0.1", 0)
                .await?;
            carried = Some(channel.into_stream());
            jumps.push(handle);
        }

        let handle = self.handshake(ssh_cfg, carried.take(), &target).await?;
        Ok(Session { handle, jumps })
    }

    /// Establish + authenticate one SSH session, either over a carried stream
    /// (through a jump) or a fresh TCP connection (the first/only hop).
    async fn handshake(
        &self,
        ssh_cfg: Arc<Config>,
        carried: Option<ChannelStream<Msg>>,
        host: &SshHost,
    ) -> Result<Handle<Client>, Error> {
        let mut handle = match carried {
            Some(stream) => client::connect_stream(ssh_cfg, stream, Client).await?,
            None => client::connect(ssh_cfg, (host.hostname.as_str(), host.port), Client).await?,
        };
        let user = host
            .user
            .clone()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_else(|| "root".into());

        // The ssh-agent first — on macOS the key usually lives in the keychain /
        // agent, not as a plaintext file russh can read. Then fall back to key
        // files (ssh_config IdentityFile, ~/.sail `key:`, default id_*).
        let mut attempted = false;
        if let Some(authed) = agent_auth(&mut handle, &user).await {
            attempted = true;
            if authed {
                return Ok(handle);
            }
        }
        if let Ok(identity) = load_identity(&host.identity_files, self.config.key_path.as_deref()) {
            attempted = true;
            if handle.authenticate_publickey(&user, Arc::new(identity)).await? {
                return Ok(handle);
            }
        }

        Err(if attempted {
            Error::AuthRejected(format!("{user}@{}", host.hostname))
        } else {
            Error::NoKey
        })
    }

    /// Connects the session if it isn't already up, with a timeout so a bad
    /// host/ProxyJump surfaces as an error instead of a hung loader. A dead
    /// session is cleared by `open_*` so the next call redials.
    async fn ensure(&self) -> Result<(), Error> {
        let mut guard = self.session.lock().await;
        if guard.is_none() {
            let session = tokio::time::timeout(CONNECT_TIMEOUT, self.dial())
                .await
                .map_err(|_| Error::Timeout(self.config.ssh_host.clone()))??;
            *guard = Some(session);
        }
        Ok(())
    }

    async fn open_session_channel(&self) -> Result<Channel<Msg>, Error> {
        self.ensure().await?;
        let mut guard = self.session.lock().await;
        let result = guard.as_ref().expect("ensured").handle.channel_open_session().await;
        if result.is_err() {
            *guard = None;
        }
        Ok(result?)
    }

    async fn open_forward(&self, host: &str, port: u16) -> Result<Channel<Msg>, Error> {
        self.ensure().await?;
        let mut guard = self.session.lock().await;
        let result = guard
            .as_ref()
            .expect("ensured")
            .handle
            .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
            .await;
        if result.is_err() {
            *guard = None;
        }
        Ok(result?)
    }

    /// The cached SSH session for a project container, dialing (and caching) it
    /// on first use. Two concurrent first-calls may both dial; the last insert
    /// wins and the extra session is dropped — cheap and rare.
    async fn container_session(&self, target: &str) -> Result<Arc<Session>, Error> {
        if let Some(session) = self.containers.lock().await.get(target).cloned() {
            return Ok(session);
        }
        let session = Arc::new(
            tokio::time::timeout(CONNECT_TIMEOUT, self.dial_alias(target, None))
                .await
                .map_err(|_| Error::Timeout(target.to_string()))??,
        );
        self.containers
            .lock()
            .await
            .insert(target.to_string(), session.clone());
        Ok(session)
    }

    /// Open a channel on a container's session, redialing once if the cached
    /// session has died (container restart / idle drop).
    async fn container_channel(&self, target: &str) -> Result<Channel<Msg>, Error> {
        let mut last = None;
        for attempt in 0..2 {
            let session = self.container_session(target).await?;
            match session.handle.channel_open_session().await {
                Ok(channel) => return Ok(channel),
                Err(e) => {
                    self.containers.lock().await.remove(target);
                    last = Some(e);
                    let _ = attempt;
                }
            }
        }
        Err(last.map(Error::from).unwrap_or(Error::Sftp("channel".into())))
    }

    async fn sftp(&self, target: &str) -> Result<SftpSession, Error> {
        let channel = self.container_channel(target).await?;
        channel.request_subsystem(true, "sftp").await?;
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| Error::Sftp(e.to_string()))
    }

    /// List a directory in a container over SFTP, resolving an empty path to the
    /// login directory. Dirs first, then case-insensitive by name.
    pub async fn fs_list(&self, target: &str, path: Option<String>) -> Result<FsListing, Error> {
        let sftp = self.sftp(target).await?;
        let dir = match path {
            Some(p) if !p.is_empty() => p,
            _ => sftp
                .canonicalize(".")
                .await
                .map_err(|e| Error::Sftp(e.to_string()))?,
        };
        let read = sftp
            .read_dir(dir.clone())
            .await
            .map_err(|e| Error::Sftp(e.to_string()))?;
        let mut entries: Vec<FileEntry> = read
            .filter(|e| e.file_name() != "." && e.file_name() != "..")
            .map(|e| {
                let meta = e.metadata();
                let name = e.file_name();
                FileEntry {
                    path: join_remote(&dir, &name),
                    name,
                    is_dir: meta.is_dir(),
                    size: meta.len(),
                }
            })
            .collect();
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(FsListing { path: dir, entries })
    }

    /// Download a file's bytes from a container (pull / open).
    pub async fn fs_read(&self, target: &str, path: String) -> Result<Vec<u8>, Error> {
        self.sftp(target)
            .await?
            .read(path)
            .await
            .map_err(|e| Error::Sftp(e.to_string()))
    }

    /// Upload files and/or folders into a container directory (drag-and-drop),
    /// recursing into folders, and streaming `transfer` progress the whole time.
    pub async fn fs_upload(
        &self,
        app: &AppHandle,
        target: &str,
        remote_dir: String,
        local_paths: Vec<String>,
        transfer_id: String,
    ) -> Result<Vec<String>, Error> {
        // The top-level landed path per dropped item (for terminal-drop inject).
        let landed: Vec<String> = local_paths
            .iter()
            .map(|p| join_remote(&remote_dir, base_name(p)))
            .collect();
        let rd = remote_dir.clone();
        let plan = tokio::task::spawn_blocking(move || plan_upload(&local_paths, &rd))
            .await
            .map_err(|e| Error::Sftp(e.to_string()))??;

        let mut progress = TransferProgress::start(
            transfer_id,
            "upload",
            transfer_label(&plan.files.iter().map(|i| i.remote.as_str()).collect::<Vec<_>>()),
            plan.files.len() as u64,
            plan.bytes,
        );
        emit_transfer(app, &progress);

        let outcome = self.run_upload(app, target, &plan, &mut progress).await;
        progress.status = if outcome.is_ok() { "done" } else { "error" };
        if let Err(e) = &outcome {
            progress.detail = Some(e.to_string());
        }
        emit_transfer(app, &progress);
        outcome.map(|_| landed)
    }

    async fn run_upload(
        &self,
        app: &AppHandle,
        target: &str,
        plan: &UploadPlan,
        progress: &mut TransferProgress,
    ) -> Result<(), Error> {
        let sftp = self.sftp(target).await?;
        for dir in &plan.dirs {
            let _ = sftp.create_dir(dir).await; // ignore "already exists"
        }
        let mut last_emit = 0u64;
        for item in &plan.files {
            let mut src = tokio::fs::File::open(&item.local).await?;
            let mut dst = sftp.create(&item.remote).await.map_err(|e| Error::Sftp(e.to_string()))?;
            let mut buf = vec![0u8; CHUNK];
            loop {
                let n = src.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n]).await?;
                progress.bytes_done += n as u64;
                if progress.bytes_done - last_emit >= EMIT_EVERY {
                    last_emit = progress.bytes_done;
                    emit_transfer(app, progress);
                }
            }
            dst.flush().await?;
            progress.files_done += 1;
            emit_transfer(app, progress);
        }
        Ok(())
    }

    /// Download files and/or folders from a container to a local directory
    /// (default `~/Downloads`), recursing, with `transfer` progress.
    pub async fn fs_download(
        &self,
        app: &AppHandle,
        target: &str,
        remote_paths: Vec<String>,
        local_dir: Option<String>,
        transfer_id: String,
    ) -> Result<Vec<String>, Error> {
        let base = local_dir
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(dirs::download_dir)
            .or_else(dirs::home_dir)
            .ok_or_else(|| Error::Sftp("no local download directory".into()))?;
        let landed: Vec<String> = remote_paths
            .iter()
            .map(|r| base.join(base_name(r)).to_string_lossy().into_owned())
            .collect();

        let sftp = self.sftp(target).await?;
        let plan = plan_download(&sftp, &remote_paths, &base).await?;

        let mut progress = TransferProgress::start(
            transfer_id,
            "download",
            transfer_label(&remote_paths.iter().map(String::as_str).collect::<Vec<_>>()),
            plan.files.len() as u64,
            plan.bytes,
        );
        emit_transfer(app, &progress);

        let outcome = run_download(&sftp, &plan, app, &mut progress).await;
        progress.status = if outcome.is_ok() { "done" } else { "error" };
        if let Err(e) = &outcome {
            progress.detail = Some(e.to_string());
        }
        emit_transfer(app, &progress);
        outcome.map(|_| landed)
    }

    /// Overwrite a remote file with `contents` (editor save).
    pub async fn fs_write(&self, target: &str, path: String, contents: Vec<u8>) -> Result<(), Error> {
        let sftp = self.sftp(target).await?;
        let mut file = sftp.create(&path).await.map_err(|e| Error::Sftp(e.to_string()))?;
        file.write_all(&contents).await?;
        file.flush().await?;
        Ok(())
    }

    pub async fn fs_rename(&self, target: &str, from: String, to: String) -> Result<(), Error> {
        self.sftp(target)
            .await?
            .rename(from, to)
            .await
            .map_err(|e| Error::Sftp(e.to_string()))
    }

    pub async fn fs_mkdir(&self, target: &str, path: String) -> Result<(), Error> {
        self.sftp(target)
            .await?
            .create_dir(path)
            .await
            .map_err(|e| Error::Sftp(e.to_string()))
    }

    /// Delete a file, or a directory and everything under it.
    pub async fn fs_delete(&self, target: &str, path: String) -> Result<(), Error> {
        let sftp = self.sftp(target).await?;
        remove_recursive(&sftp, &path).await
    }

    /// Proxies one HTTP request to the control plane over a direct-tcpip
    /// forward. `Connection: close` lets us read the response to EOF without a
    /// chunked-body parser. The bearer token is injected here so it never
    /// reaches the webview.
    pub async fn sail_request(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
        if_match: Option<String>,
    ) -> Result<SailResponse, Error> {
        let channel = self
            .open_forward(&self.config.server_host, self.config.server_port)
            .await?;
        let mut stream = channel.into_stream();

        let mut req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n",
            host = self.config.server_host,
            port = self.config.server_port,
        );
        if let Some(token) = &self.config.token {
            req.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        if let Some(etag) = &if_match {
            req.push_str(&format!("If-Match: {etag}\r\n"));
        }
        let body_bytes = body.unwrap_or_default();
        if !body_bytes.is_empty() {
            req.push_str("Content-Type: application/json\r\n");
            req.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
        }
        req.push_str("\r\n");
        req.push_str(&body_bytes);

        let raw = tokio::time::timeout(REQUEST_TIMEOUT, async {
            stream.write_all(req.as_bytes()).await?;
            stream.flush().await?;
            let mut raw = Vec::new();
            stream.read_to_end(&mut raw).await?;
            Ok::<_, Error>(raw)
        })
        .await
        .map_err(|_| Error::Timeout(format!("{}:{}", self.config.server_host, self.config.server_port)))??;

        parse_http(&raw)
    }

    pub async fn terminal_open(
        &self,
        app: AppHandle,
        id: String,
        target: Option<String>,
        cols: u32,
        rows: u32,
    ) -> Result<(), Error> {
        // A named target opens a shell in that project container (over its
        // cached session, shared with the file bridge); no target = a shell on
        // the node over the control-plane session.
        let mut channel = match target.as_deref().filter(|t| !t.is_empty()) {
            Some(alias) => self.container_channel(alias).await?,
            None => self.open_session_channel().await?,
        };
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;

        let (tx, mut rx) = mpsc::channel::<TermCmd>(256);
        self.terminals.lock().await.insert(id.clone(), tx);

        let data_event = format!("terminal://data/{id}");
        let exit_event = format!("terminal://exit/{id}");

        tokio::spawn(async move {
            // The container session is kept alive by the `containers` cache; the
            // node session lives in `self`. Nothing to own here.
            loop {
                tokio::select! {
                    msg = channel.wait() => match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let _ = app.emit(&data_event, data.to_vec());
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let _ = app.emit(&data_event, data.to_vec());
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    },
                    cmd = rx.recv() => match cmd {
                        Some(TermCmd::Write(bytes)) => {
                            let _ = channel.data(&bytes[..]).await;
                        }
                        Some(TermCmd::Resize(c, r)) => {
                            let _ = channel.window_change(c, r, 0, 0).await;
                        }
                        Some(TermCmd::Close) | None => break,
                    }
                }
            }
            let _ = app.emit(&exit_event, ());
        });

        Ok(())
    }

    async fn send(&self, id: &str, cmd: TermCmd) -> Result<(), Error> {
        let terminals = self.terminals.lock().await;
        let tx = terminals.get(id).ok_or_else(|| Error::NoTerminal(id.into()))?;
        tx.send(cmd).await.map_err(|_| Error::NoTerminal(id.into()))
    }

    pub async fn terminal_write(&self, id: &str, data: Vec<u8>) -> Result<(), Error> {
        self.send(id, TermCmd::Write(data)).await
    }

    pub async fn terminal_resize(&self, id: &str, cols: u32, rows: u32) -> Result<(), Error> {
        self.send(id, TermCmd::Resize(cols, rows)).await
    }

    pub async fn terminal_close(&self, id: &str) -> Result<(), Error> {
        let _ = self.send(id, TermCmd::Close).await;
        self.terminals.lock().await.remove(id);
        Ok(())
    }
}

/// Try every identity the ssh-agent holds. Returns `None` if there's no agent
/// or it's empty (so the caller falls back to key files), `Some(true)` on a
/// successful auth, `Some(false)` if the agent had keys but none were accepted.
async fn agent_auth(handle: &mut Handle<Client>, user: &str) -> Option<bool> {
    let mut agent = AgentClient::connect_env().await.ok()?;
    let identities = agent.request_identities().await.ok()?;
    if identities.is_empty() {
        return None;
    }
    for key in identities {
        let (returned, result) = handle.authenticate_future(user, key, agent).await;
        agent = returned;
        if matches!(result, Ok(true)) {
            return Some(true);
        }
    }
    Some(false)
}

/// Pick the first usable private key: the host's `IdentityFile`s, then any
/// `key:` from `~/.sail/config.yaml`, then the default `~/.ssh/id_*`.
fn load_identity(host_files: &[PathBuf], explicit: Option<&str>) -> Result<key::KeyPair, Error> {
    let mut candidates: Vec<PathBuf> = host_files.to_vec();
    if let Some(path) = explicit {
        candidates.push(expand_tilde(path));
    }
    if let Some(home) = dirs::home_dir() {
        for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            candidates.push(home.join(".ssh").join(name));
        }
    }
    for path in candidates {
        if path.exists() {
            if let Ok(key) = load_secret_key(&path, None) {
                return Ok(key);
            }
        }
    }
    Err(Error::NoKey)
}

fn read_ssh_config() -> String {
    dirs::home_dir()
        .map(|home| std::fs::read_to_string(home.join(".ssh/config")).unwrap_or_default())
        .unwrap_or_default()
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Resolve an ssh alias against `~/.ssh/config`: hostname defaults to the alias,
/// port to 22, and any matching `Host` block fills in the rest (first value
/// wins, matching ssh's own precedence).
fn resolve_host(alias: &str, cfg: &str) -> SshHost {
    let mut host = SshHost {
        hostname: alias.to_string(),
        port: 22,
        ..Default::default()
    };
    apply_ssh_config(&mut host, alias, cfg);
    host
}

/// Parse a `ProxyJump` spec (`[user@]host[:port]`), then layer the referenced
/// alias's own config underneath so a jump can carry its own HostName/key.
fn resolve_from_spec(spec: &str, cfg: &str) -> SshHost {
    let (user, rest) = match spec.split_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, spec),
    };
    let (name, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok()),
        None => (rest, None),
    };
    let mut host = resolve_host(name, cfg);
    if user.is_some() {
        host.user = user;
    }
    if let Some(p) = port {
        host.port = p;
    }
    host
}

/// The ordered list of jump hops in front of `target` (its `ProxyJump` chain,
/// each hop's own jumps first). Depth-capped against config cycles.
fn build_hops(target: &SshHost, cfg: &str) -> Vec<SshHost> {
    let mut out = Vec::new();
    collect_hops(target, cfg, &mut out, 0);
    out
}

fn collect_hops(host: &SshHost, cfg: &str, out: &mut Vec<SshHost>, depth: usize) {
    if depth > 10 {
        return;
    }
    if let Some(jump) = &host.proxy_jump {
        for spec in jump.split(',') {
            let spec = spec.trim();
            if spec.is_empty() || spec.eq_ignore_ascii_case("none") {
                continue;
            }
            let hop = resolve_from_spec(spec, cfg);
            collect_hops(&hop, cfg, out, depth + 1);
            out.push(hop);
        }
    }
}

fn apply_ssh_config(host: &mut SshHost, alias: &str, cfg: &str) {
    let mut matching = false;
    let (mut set_hostname, mut set_user, mut set_port, mut set_jump) = (false, false, false, false);

    for line in cfg.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (keyword, value) = split_kv(line);
        let keyword = keyword.to_ascii_lowercase();

        match keyword.as_str() {
            "host" => matching = value.split_whitespace().any(|p| glob_match(p, alias)),
            "match" => matching = false,
            _ if !matching => {}
            "hostname" if !set_hostname => {
                host.hostname = value.to_string();
                set_hostname = true;
            }
            "user" if !set_user => {
                host.user = Some(value.to_string());
                set_user = true;
            }
            "port" if !set_port => {
                if let Ok(p) = value.parse() {
                    host.port = p;
                }
                set_port = true;
            }
            "identityfile" => host.identity_files.push(expand_tilde(value)),
            "proxyjump" if !set_jump => {
                if !value.eq_ignore_ascii_case("none") {
                    host.proxy_jump = Some(value.to_string());
                }
                set_jump = true;
            }
            _ => {}
        }
    }
}

/// Split an ssh_config line into keyword + value (`Key value` or `Key=value`).
fn split_kv(line: &str) -> (&str, &str) {
    let idx = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let key = &line[..idx];
    let value = line[idx..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim();
    (key, value)
}

/// Minimal ssh_config pattern match: `*` (any run) and `?` (one char).
fn glob_match(pattern: &str, name: &str) -> bool {
    fn matches(p: &[u8], n: &[u8]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some(b'*') => matches(&p[1..], n) || (!n.is_empty() && matches(p, &n[1..])),
            Some(b'?') => !n.is_empty() && matches(&p[1..], &n[1..]),
            Some(&c) => !n.is_empty() && n[0] == c && matches(&p[1..], &n[1..]),
        }
    }
    matches(pattern.as_bytes(), name.as_bytes())
}

/// Split `HTTP/1.1 200 OK\r\n<headers>\r\n\r\n<body>` into status, ETag, body.
/// We send `Connection: close` and read to EOF, so the body is complete; if the
/// server still chose chunked transfer-encoding, decode the chunk framing.
fn parse_http(raw: &[u8]) -> Result<SailResponse, Error> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or(Error::BadResponse)?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let body_bytes = &raw[split + 4..];

    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or(Error::BadResponse)?;

    let mut etag = None;
    let mut chunked = false;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("etag:") {
            let _ = rest;
            etag = Some(line[line.find(':').unwrap() + 1..].trim().to_string());
        } else if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
            chunked = true;
        }
    }

    let body = if chunked {
        String::from_utf8_lossy(&dechunk(body_bytes)).to_string()
    } else {
        String::from_utf8_lossy(body_bytes).to_string()
    };

    Ok(SailResponse { status, etag, body })
}

/// Decode HTTP/1.1 chunked framing: repeated `<hex-len>\r\n<bytes>\r\n`, ending
/// at a zero-length chunk. Malformed framing yields what was decoded so far.
fn dechunk(mut buf: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(eol) = buf.windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_str = String::from_utf8_lossy(&buf[..eol]);
        let size = usize::from_str_radix(size_str.trim().split(';').next().unwrap_or("").trim(), 16);
        let Ok(size) = size else { break };
        if size == 0 {
            break;
        }
        let start = eol + 2;
        let end = start + size;
        if end > buf.len() {
            out.extend_from_slice(&buf[start.min(buf.len())..]);
            break;
        }
        out.extend_from_slice(&buf[start..end]);
        buf = &buf[(end + 2).min(buf.len())..];
    }
    out
}

/// Parse both YAML flow (`{host: x, server: '...'}`) and block styles — the same
/// two shapes SnakeYAML writes and `config.ts` reads.
fn parse_yaml(content: &str) -> HashMap<String, String> {
    let trimmed = content.trim();
    let mut out = HashMap::new();
    let unquote = |v: &str| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();

    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        let inner = &trimmed[1..trimmed.len() - 1];
        for pair in split_flow(inner) {
            if let Some(colon) = pair.find(':') {
                let key = pair[..colon].trim().to_string();
                if !key.is_empty() {
                    out.insert(key, unquote(&pair[colon + 1..]));
                }
            }
        }
        return out;
    }

    for line in content.lines() {
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_string();
            if !key.is_empty() && !key.starts_with('#') {
                out.insert(key, unquote(&line[colon + 1..]));
            }
        }
    }
    out
}

/// Split a flow mapping's interior on commas, respecting quotes (the CLI
/// single-quotes URLs whose colons would otherwise mis-split).
fn split_flow(inner: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in inner.chars() {
        match quote {
            Some(q) => {
                current.push(ch);
                if ch == q {
                    quote = None;
                }
            }
            None => match ch {
                '\'' | '"' => {
                    quote = Some(ch);
                    current.push(ch);
                }
                ',' => {
                    parts.push(std::mem::take(&mut current));
                }
                _ => current.push(ch),
            },
        }
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

/// Join a remote directory and a file name into an absolute POSIX path,
/// tolerating a trailing slash and a root ("/") base.
fn join_remote(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

fn base_name(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// "readme.md" for one item, "readme.md +2" for several.
fn transfer_label(paths: &[&str]) -> String {
    match paths.split_first() {
        Some((first, rest)) if rest.is_empty() => base_name(first).to_string(),
        Some((first, rest)) => format!("{} +{}", base_name(first), rest.len()),
        None => "(nothing)".to_string(),
    }
}

/// Walk the local paths (files and/or folders) into a flat upload plan: the
/// remote directories to create (parents first) and every file to send.
fn plan_upload(local_paths: &[String], remote_dir: &str) -> std::io::Result<UploadPlan> {
    let mut plan = UploadPlan::default();
    for local in local_paths {
        let path = Path::new(local);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad source path"))?;
        let remote = join_remote(remote_dir, name);
        let meta = std::fs::symlink_metadata(path)?;
        if meta.is_dir() {
            plan.dirs.push(remote.clone());
            walk_upload(path, &remote, &mut plan)?;
        } else if meta.is_file() {
            plan.bytes += meta.len();
            plan.files.push(UploadItem { local: path.to_path_buf(), remote });
        }
    }
    Ok(plan)
}

fn walk_upload(dir: &Path, remote_base: &str, plan: &mut UploadPlan) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let remote = join_remote(remote_base, name);
        let meta = entry.metadata()?;
        if meta.is_dir() {
            plan.dirs.push(remote.clone());
            walk_upload(&entry.path(), &remote, plan)?;
        } else if meta.is_file() {
            plan.bytes += meta.len();
            plan.files.push(UploadItem { local: entry.path(), remote });
        }
    }
    Ok(())
}

/// Walk the remote paths over SFTP into a flat download plan (local dirs are
/// made on the fly by `run_download`). Iterative to avoid boxed async recursion.
async fn plan_download(
    sftp: &SftpSession,
    remote_paths: &[String],
    base: &Path,
) -> Result<DownloadPlan, Error> {
    let mut plan = DownloadPlan::default();
    let mut stack: Vec<(String, PathBuf)> = remote_paths
        .iter()
        .map(|r| (r.clone(), base.join(base_name(r))))
        .collect();
    while let Some((remote, local)) = stack.pop() {
        let meta = sftp.metadata(remote.clone()).await.map_err(|e| Error::Sftp(e.to_string()))?;
        if meta.is_dir() {
            let read = sftp.read_dir(remote.clone()).await.map_err(|e| Error::Sftp(e.to_string()))?;
            for entry in read {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                stack.push((join_remote(&remote, &name), local.join(&name)));
            }
        } else {
            plan.bytes += meta.len();
            plan.files.push(DownloadItem { remote, local });
        }
    }
    Ok(plan)
}

async fn run_download(
    sftp: &SftpSession,
    plan: &DownloadPlan,
    app: &AppHandle,
    progress: &mut TransferProgress,
) -> Result<(), Error> {
    let mut last_emit = 0u64;
    for item in &plan.files {
        if let Some(parent) = item.local.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut src = sftp.open(item.remote.clone()).await.map_err(|e| Error::Sftp(e.to_string()))?;
        let mut dst = tokio::fs::File::create(&item.local).await?;
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            progress.bytes_done += n as u64;
            if progress.bytes_done - last_emit >= EMIT_EVERY {
                last_emit = progress.bytes_done;
                emit_transfer(app, progress);
            }
        }
        dst.flush().await?;
        progress.files_done += 1;
        emit_transfer(app, progress);
    }
    Ok(())
}

/// Delete a remote path: a file directly, or a directory by removing all its
/// contents (files first, then dirs deepest-first) before the dir itself.
async fn remove_recursive(sftp: &SftpSession, path: &str) -> Result<(), Error> {
    let meta = sftp.metadata(path.to_string()).await.map_err(|e| Error::Sftp(e.to_string()))?;
    if !meta.is_dir() {
        return sftp.remove_file(path).await.map_err(|e| Error::Sftp(e.to_string()));
    }
    let mut dirs = vec![path.to_string()];
    let mut stack = vec![path.to_string()];
    while let Some(current) = stack.pop() {
        let read = sftp.read_dir(current.clone()).await.map_err(|e| Error::Sftp(e.to_string()))?;
        for entry in read {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = join_remote(&current, &name);
            if entry.metadata().is_dir() {
                dirs.push(child.clone());
                stack.push(child);
            } else {
                sftp.remove_file(&child).await.map_err(|e| Error::Sftp(e.to_string()))?;
            }
        }
    }
    dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    for dir in dirs {
        sftp.remove_dir(&dir).await.map_err(|e| Error::Sftp(e.to_string()))?;
    }
    Ok(())
}

fn parse_server(server: &str) -> (String, u16) {
    let (scheme, rest) = match server.split_once("://") {
        Some((s, r)) => (s, r),
        None => ("http", server),
    };
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(default_port(scheme))),
        None => (authority.to_string(), default_port(scheme)),
    };
    let host = if host == "localhost" { "127.0.0.1".into() } else { host };
    (host, port)
}

fn default_port(scheme: &str) -> u16 {
    if scheme == "https" {
        443
    } else {
        80
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "\
Host devbox
  HostName 10.0.0.5
  User sail
  Port 2222
  IdentityFile ~/.ssh/sail_key
  ProxyJump bastion

Host bastion
  HostName jump.example.com
  User ec2-user
";

    #[test]
    fn glob_matches_wildcards() {
        assert!(glob_match("*", "devbox"));
        assert!(glob_match("dev*", "devbox"));
        assert!(glob_match("d?vbox", "devbox"));
        assert!(!glob_match("prod*", "devbox"));
    }

    #[test]
    fn split_kv_handles_space_and_equals() {
        assert_eq!(split_kv("HostName example.com"), ("HostName", "example.com"));
        assert_eq!(split_kv("Port=2222"), ("Port", "2222"));
        assert_eq!(split_kv("  User   sail  ".trim()), ("User", "sail"));
    }

    #[test]
    fn resolve_host_reads_alias_block() {
        let host = resolve_host("devbox", CONFIG);
        assert_eq!(host.hostname, "10.0.0.5");
        assert_eq!(host.user.as_deref(), Some("sail"));
        assert_eq!(host.port, 2222);
        assert_eq!(host.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(host.identity_files.len(), 1);
    }

    #[test]
    fn unknown_alias_falls_back_to_itself() {
        let host = resolve_host("nowhere", CONFIG);
        assert_eq!(host.hostname, "nowhere");
        assert_eq!(host.port, 22);
        assert!(host.proxy_jump.is_none());
    }

    #[test]
    fn build_hops_expands_proxy_jump_chain() {
        let target = resolve_host("devbox", CONFIG);
        let hops = build_hops(&target, CONFIG);
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].hostname, "jump.example.com");
        assert_eq!(hops[0].user.as_deref(), Some("ec2-user"));
        assert_eq!(hops[0].port, 22);
    }

    #[test]
    fn join_remote_handles_root_and_trailing_slash() {
        assert_eq!(join_remote("/home/dev", "a.txt"), "/home/dev/a.txt");
        assert_eq!(join_remote("/home/dev/", "a.txt"), "/home/dev/a.txt");
        assert_eq!(join_remote("/", "a.txt"), "/a.txt");
        assert_eq!(join_remote("", "a.txt"), "/a.txt");
    }

    #[test]
    fn transfer_label_singular_and_plural() {
        assert_eq!(base_name("/a/b/readme.md"), "readme.md");
        assert_eq!(base_name("/a/b/"), "b");
        assert_eq!(transfer_label(&["/a/x.txt"]), "x.txt");
        assert_eq!(transfer_label(&["/a/x.txt", "/a/y.txt", "/a/z.txt"]), "x.txt +2");
        assert_eq!(transfer_label(&[]), "(nothing)");
    }

    #[test]
    fn plan_upload_walks_folders_recursively() {
        let base = std::env::temp_dir().join(format!("mast_plan_{}", std::process::id()));
        let sub = base.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(base.join("top.txt"), b"1234").unwrap();
        std::fs::write(sub.join("deep.txt"), b"567").unwrap();

        let plan = plan_upload(&[base.to_string_lossy().into_owned()], "/remote").unwrap();
        let name = base.file_name().unwrap().to_str().unwrap();

        assert_eq!(plan.bytes, 7); // 4 + 3
        assert_eq!(plan.files.len(), 2);
        assert!(plan.dirs.contains(&format!("/remote/{name}")));
        assert!(plan.dirs.contains(&format!("/remote/{name}/nested")));
        let remotes: Vec<_> = plan.files.iter().map(|f| f.remote.clone()).collect();
        assert!(remotes.contains(&format!("/remote/{name}/top.txt")));
        assert!(remotes.contains(&format!("/remote/{name}/nested/deep.txt")));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn parse_server_pins_localhost_and_defaults_port() {
        assert_eq!(parse_server("http://localhost:7070"), ("127.0.0.1".into(), 7070));
        assert_eq!(parse_server("https://api.example.com"), ("api.example.com".into(), 443));
    }

    #[test]
    fn dechunk_decodes_framing() {
        let raw = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        assert_eq!(dechunk(raw), b"Wikipedia");
    }

    #[test]
    fn parse_http_reads_status_and_etag() {
        let raw = b"HTTP/1.1 200 OK\r\nETag: \"v7\"\r\nContent-Length: 2\r\n\r\n{}";
        let resp = parse_http(raw).unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.etag.as_deref(), Some("\"v7\""));
        assert_eq!(resp.body, "{}");
    }

    /// Live check that ssh-agent auth works end to end: needs a running sshd on
    /// 127.0.0.1:22 and an agent (SSH_AUTH_SOCK) holding a key authorized for
    /// $USER. Ignored by default; run with `--ignored` in that setup.
    #[tokio::test]
    #[ignore]
    async fn agent_auth_against_localhost() {
        let user = std::env::var("USER").unwrap();
        let mut handle = client::connect(Arc::new(Config::default()), ("127.0.0.1", 22), Client)
            .await
            .expect("connect");
        assert_eq!(agent_auth(&mut handle, &user).await, Some(true));
    }

    /// Live SFTP round-trip (list + upload + download) with the same russh-sftp
    /// calls the file bridge uses. Same prerequisites as the agent test; run
    /// with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn sftp_roundtrip_against_localhost() {
        let user = std::env::var("USER").unwrap();
        let mut handle = client::connect(Arc::new(Config::default()), ("127.0.0.1", 22), Client)
            .await
            .expect("connect");
        assert_eq!(agent_auth(&mut handle, &user).await, Some(true));

        let mut channel = handle.channel_open_session().await.expect("channel");
        channel.request_subsystem(true, "sftp").await.expect("subsystem");
        let sftp = SftpSession::new(channel.into_stream()).await.expect("sftp");

        let home = sftp.canonicalize(".").await.expect("canonicalize");
        assert!(home.starts_with('/'), "home should be absolute: {home}");

        let path = join_remote(&home, "mast_fs_bridge_test.txt");
        let body = b"file bridge over russh-sftp\n";
        let mut file = sftp.create(&path).await.expect("create");
        file.write_all(body).await.expect("write_all");
        file.flush().await.expect("flush");
        drop(file);
        assert_eq!(sftp.read(&path).await.expect("read"), body);

        let names: Vec<String> = sftp
            .read_dir(home.clone())
            .await
            .expect("read_dir")
            .map(|e| e.file_name())
            .collect();
        assert!(names.iter().any(|n| n == "mast_fs_bridge_test.txt"));
        sftp.remove_file(&path).await.ok();

        // Folder path: mkdir + a nested file (what recursive upload/download do).
        let subdir = join_remote(&home, "mast_fs_bridge_dir");
        sftp.create_dir(&subdir).await.ok();
        let nested = join_remote(&subdir, "inside.txt");
        let mut nf = sftp.create(&nested).await.expect("create nested");
        nf.write_all(b"nested").await.expect("write nested");
        nf.flush().await.expect("flush nested");
        drop(nf);
        assert_eq!(sftp.read(&nested).await.expect("read nested"), b"nested");

        // Rename.
        let renamed = join_remote(&home, "mast_fs_renamed.txt");
        sftp.rename(nested.clone(), renamed.clone()).await.expect("rename");
        assert_eq!(sftp.read(&renamed).await.expect("read renamed"), b"nested");
        sftp.rename(renamed, nested.clone()).await.ok();

        // Recursive delete of the populated directory.
        remove_recursive(&sftp, &subdir).await.expect("remove_recursive");
        assert!(sftp.metadata(subdir).await.is_err(), "dir should be gone");
    }
}
