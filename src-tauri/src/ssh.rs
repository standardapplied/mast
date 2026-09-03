//! The in-process SSH backend that makes Mast a thin client on mobile as well
//! as desktop. Every capability the app needs — HTTP to the control plane, an
//! interactive terminal, (later) SFTP file transfer — rides one russh session
//! to the devbox, with no `ssh` subprocess. That is the whole reason for the
//! A spawned `ssh` binary can't run inside the iOS/Android sandbox; this
//! library can. russh 0.45 wired behind Tauri commands.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Config, Handle, Handler, Msg};
use russh::keys::agent::client::AgentClient;
use russh::keys::key;
use russh::keys::load_secret_key;
use russh::{Channel, ChannelMsg, ChannelStream};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Generous bound for a recursive delete (`rm -rf`): the remote does the work in
/// one shot, but a huge tree over a slow link can still take a while.
const EXEC_TIMEOUT: Duration = Duration::from_secs(300);

/// Keepalive probe cadence. A silently dead link (laptop lid, network change) surfaces as a
/// closed session within `KEEPALIVE_INTERVAL * (keepalive_max + 1)` — ~40s — instead of
/// freezing every terminal until TCP gives up many minutes later.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);

/// The SSH client config for every hop: defaults plus keepalives (see [`KEEPALIVE_INTERVAL`]).
fn client_config() -> Arc<Config> {
    let mut cfg = Config::default();
    cfg.keepalive_interval = Some(KEEPALIVE_INTERVAL);
    cfg.keepalive_max = 3;
    Arc::new(cfg)
}

/// Default byte cap for `fs_read` when the webview doesn't pass one: generous
/// for anything an in-app editor/viewer opens, small enough that a stray click
/// on a core dump can't balloon the process.
pub const DEFAULT_READ_CAP: u64 = 10 * 1024 * 1024;
/// Defaults for `fs_list_deep`: how many levels below the requested directory
/// to walk, and the total-entry budget across all returned listings.
pub const DEEP_LIST_DEPTH: u32 = 3;
pub const DEEP_LIST_MAX_ENTRIES: usize = 2000;
/// How many directory listings the deep walker keeps in flight at once. The
/// SFTP session multiplexes request ids, so pipelining turns a
/// round-trip-per-directory walk into round-trip-per-batch; the cap also
/// bounds wasted reads when the entry budget cuts a level short.
const DEEP_LIST_CONCURRENCY: usize = 16;

/// Directories the deep walker never descends into (dependency/build trees that
/// dwarf the source they belong to). They still appear as entries in their
/// parent's listing, and listing one *directly* works normally — the requested
/// root is never pruned.
const PRUNED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".cargo",
    ".gradle",
    ".local",
    ".m2",
    ".npm",
    ".nvm",
    ".rustup",
];

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
    #[error("refusing to open a stream to a non-allowlisted or malformed path")]
    BadStreamPath,
    #[error("no session with id {0}")]
    NoSession(String),
    #[error("pty session: {0}")]
    PtySession(String),
    #[error("sftp: {0}")]
    Sftp(String),
    #[error("too large: {path} is {size} bytes (limit {max} bytes) — download it instead")]
    TooLarge { path: String, size: u64, max: u64 },
    #[error("{0}")]
    Login(String),
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


/// One lazily-connected russh session, shared by the HTTP proxy and every
/// terminal. Held in Tauri managed state.
pub struct Backend {
    config: SailConfig,
    /// The API bearer token, mutable at runtime so login/logout take effect
    /// without a restart. Mirrors `~/.sail/config.yaml`.
    token: Mutex<Option<String>>,
    session: Mutex<Option<Arc<Session>>>,
    /// One cached SSH session per project container (keyed by ssh alias), shared
    /// by that container's terminals and SFTP channels — one connection, many
    /// multiplexed channels. Evicted and redialed if it dies.
    containers: Mutex<HashMap<String, Arc<Session>>>,
    /// One cached SFTP subsystem per target, riding that target's pooled SSH
    /// session, so only a target's first `fs_*` call pays channel-open +
    /// subsystem + protocol handshake. russh-sftp multiplexes request ids, so
    /// concurrent calls share one session safely. `with_sftp` evicts and
    /// reopens once on transport errors.
    sftp_pool: Mutex<HashMap<String, Arc<SftpSession>>>,
    /// SFTP subsystem opens since launch — lets tests observe session reuse
    /// instead of asserting it by vibes.
    sftp_opens: AtomicU64,
    /// Host-owned pty sessions attached over SSH direct-streamlocal, keyed by a
    /// client-chosen id. The sender carries keystrokes/resize/detach into the
    /// session driver; the session outlives the connection on the host side.
    /// Shared with each driver task so it can evict its own id when the session
    /// ends on its own, not only when the UI closes the tab.
    sessions: Arc<Mutex<HashMap<String, mpsc::Sender<crate::pty::SessionCmd>>>>,
    /// The remote `$HOME` for the node SSH user, resolved once and cached — so a `~/`-relative
    /// socket path lands in the right home whether the box logs in as root, dev, or anyone else.
    home: Mutex<Option<String>>,
    /// Live long-read streams (SSE tails: events + agent log), keyed by a
    /// client-chosen id. The sender signals the pump task to stop when the
    /// webview closes the stream.
    streams: Mutex<HashMap<String, mpsc::Sender<()>>>,
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

/// A bounded subtree from `fs_list_deep`: one complete `FsListing` per walked
/// directory (parents before children), plus whether the walk stopped at the
/// entry budget before covering the requested depth. When the requested
/// directory itself overflowed the budget, `next_cursor` resumes its next
/// page — so no entry is ever unreachable, just paged.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepListing {
    pub listings: Vec<FsListing>,
    pub truncated: bool,
    pub next_cursor: Option<PageCursor>,
}

/// Continuation for a paged root listing: the sort key of the last delivered
/// entry. The next page is "everything ordered after this", so entries
/// inserted or deleted earlier in the directory between requests shift
/// nothing — a numeric offset would silently skip whatever slid into the
/// already-delivered range.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageCursor {
    pub is_dir: bool,
    pub name: String,
}

/// What a checked write did: applied, or refused because the file changed.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WriteOutcome {
    Saved,
    Conflict,
}

/// What the viewer/save path needs to know about one remote path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub is_dir: bool,
    pub size: u64,
    /// Modification time as Unix seconds, when the server reports one.
    pub modified: Option<u64>,
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

/// Maps a session's non-data event to the JSON the webview renders as terminal-state UI.
fn session_meta(event: &crate::pty::SessionEvent) -> serde_json::Value {
    use crate::pty::SessionEvent;
    match event {
        SessionEvent::Replaying { safe } => json!({ "kind": "replaying", "safe": safe }),
        SessionEvent::ReplayDone => json!({ "kind": "replay_done" }),
        SessionEvent::Paused => json!({ "kind": "paused" }),
        SessionEvent::Continued => json!({ "kind": "continued" }),
        SessionEvent::WriterChanged(fde) => json!({ "kind": "writer_changed", "fde": fde }),
        SessionEvent::Resized { cols, rows } => json!({ "kind": "resized", "cols": cols, "rows": rows }),
        SessionEvent::Output(_) | SessionEvent::Ended(_) => json!({ "kind": "other" }),
    }
}

/// How the pane should read a session failure: a host refusal (bad token, foreign session, dead
/// container, protocol skew) would fail identically on every retry; only a genuine transport
/// failure is worth reattaching for.
pub fn end_class(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::InvalidData => "refused",
        _ => "transport",
    }
}

fn emit_transfer(app: &AppHandle, progress: &TransferProgress) {
    let _ = app.emit("transfer", progress);
}

impl Backend {
    pub fn new() -> Result<Self, Error> {
        let config = SailConfig::load()?;
        let token = config.token.clone();
        Ok(Backend {
            config,
            token: Mutex::new(token),
            session: Mutex::new(None),
            containers: Mutex::new(HashMap::new()),
            sftp_pool: Mutex::new(HashMap::new()),
            sftp_opens: AtomicU64::new(0),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            home: Mutex::new(None),
            streams: Mutex::new(HashMap::new()),
        })
    }

    pub fn describe(&self) -> &SailConfig {
        &self.config
    }

    pub async fn has_token(&self) -> bool {
        self.token.lock().await.is_some()
    }

    pub async fn token_kind(&self) -> &'static str {
        match self.token.lock().await.as_deref() {
            Some(t) if t.starts_with("sess_") => "session",
            Some(_) => "api",
            None => "none",
        }
    }

    /// Set (login) or clear (logout) the API token: persist to config, update the
    /// in-memory value, and drop the control-plane session so the next request
    /// re-authenticates.
    pub async fn set_token(&self, token: Option<String>) -> Result<(), Error> {
        write_config_token(token.as_deref())?;
        *self.token.lock().await = token;
        *self.session.lock().await = None;
        Ok(())
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
        self.ensure().await.map(|_| ())
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
        let ssh_cfg = client_config();

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
    /// host/ProxyJump surfaces as an error instead of a hung loader. Returns a
    /// shared handle so callers open channels without holding the cache lock —
    /// a slow or hung open must never serialize every other backend operation.
    async fn ensure(&self) -> Result<Arc<Session>, Error> {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_ref() {
            return Ok(session.clone());
        }
        let session = Arc::new(
            tokio::time::timeout(CONNECT_TIMEOUT, self.dial())
                .await
                .map_err(|_| Error::Timeout(self.config.ssh_host.clone()))??,
        );
        *guard = Some(session.clone());
        Ok(session)
    }

    /// Drops the cached session so the next call redials — but only when it is
    /// still the one that failed, so a stale failure never clobbers a fresh dial.
    async fn evict(&self, failed: &Arc<Session>) {
        let mut guard = self.session.lock().await;
        if guard.as_ref().is_some_and(|s| Arc::ptr_eq(s, failed)) {
            *guard = None;
        }
    }

    async fn open_session_channel(&self) -> Result<Channel<Msg>, Error> {
        let session = self.ensure().await?;
        let result = session.handle.channel_open_session().await;
        if result.is_err() {
            self.evict(&session).await;
        }
        Ok(result?)
    }

    pub(crate) async fn open_forward(&self, host: &str, port: u16) -> Result<Channel<Msg>, Error> {
        let session = self.ensure().await?;
        let result = session
            .handle
            .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
            .await;
        if result.is_err() {
            self.evict(&session).await;
        }
        Ok(result?)
    }

    /// The remote `$HOME` for the node SSH user, resolved once over the session and cached. Used to
    /// expand a `~/`-relative socket path — the pty host writes its socket under whichever home the
    /// box logs in as (root on a bare-metal node, dev in a container), so we cannot hardcode it.
    async fn remote_home(&self) -> Result<String, Error> {
        if let Some(home) = self.home.lock().await.clone() {
            return Ok(home);
        }
        let mut channel = self.open_session_channel().await?;
        channel.exec(true, "printf %s \"$HOME\"".as_bytes()).await?;
        let mut out = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {}
            }
        }
        let home = String::from_utf8_lossy(&out).trim().to_string();
        if home.is_empty() || !home.starts_with('/') {
            return Err(Error::PtySession(
                "could not resolve the remote home for the pty socket".into(),
            ));
        }
        *self.home.lock().await = Some(home.clone());
        Ok(home)
    }

    /// Expands `~` / `~/…` against the remote home; absolute (and other) paths pass through. Used
    /// for the pty socket and the session's working directory, which both live under the box user's
    /// home and differ by login (root on a bare-metal node, dev in a container).
    async fn resolve_path(&self, path: &str) -> Result<String, Error> {
        if path == "~" {
            return self.remote_home().await;
        }
        match path.strip_prefix("~/") {
            Some(rest) => Ok(format!("{}/{}", self.remote_home().await?.trim_end_matches('/'), rest)),
            None => Ok(path.to_string()),
        }
    }

    /// Opens a channel forwarded to a unix-domain socket on the control-plane host — the pty
    /// session host at `~/.sail/pty.sock`. Mirrors {@link open_forward} for streamlocal.
    pub(crate) async fn open_streamlocal(&self, socket_path: &str) -> Result<Channel<Msg>, Error> {
        let resolved = self.resolve_path(socket_path).await?;
        // Two attempts: a cached session that died since its last use fails (or hangs — hence the
        // timeout) on channel-open; evicting it closes every channel that rode it, which is what
        // wakes their panes to reconnect, and the second attempt rides a fresh dial. A peer that
        // REFUSES the channel is the opposite case — SSH is healthy, the pty-host socket isn't
        // there — so the shared session (and everything riding it) must be left alone.
        let mut last: Option<Error> = None;
        for _ in 0..2 {
            let session = self.ensure().await?;
            let open = session.handle.channel_open_direct_streamlocal(resolved.clone());
            match tokio::time::timeout(CONNECT_TIMEOUT, open).await {
                Ok(Ok(channel)) => return Ok(channel),
                Ok(Err(russh::Error::ChannelOpenFailure(reason))) => {
                    return Err(Error::PtySession(format!(
                        "pty host refused the connection at {resolved} ({reason:?}) — is sail-pty-host running?"
                    )));
                }
                Ok(Err(e)) => {
                    self.evict(&session).await;
                    last = Some(e.into());
                }
                Err(_) => {
                    self.evict(&session).await;
                    last = Some(Error::Timeout("pty socket channel".into()));
                }
            }
        }
        Err(last.expect("two failed attempts"))
    }

    /// Attaches a terminal ({@code id}) to a host-owned pty session over a streamlocal channel,
    /// speaking the pty-host protocol directly. Resolves once the host has acknowledged the
    /// Create (when asked) and the Attach, so a caller that gets `Ok` knows the session exists;
    /// a prologue failure is the error, classified by [`end_class`]. From then on output frames
    /// become `session://data/{id}`, the ending becomes `session://exit/{id}`, and
    /// flow-control/roster/resize become `session://meta/{id}`. Keystrokes/resize/detach ride the
    /// returned sender via the session_* methods. The session survives this connection on the
    /// host — closing here only detaches.
    pub async fn session_open(
        &self,
        app: AppHandle,
        id: String,
        socket_path: String,
        mut req: crate::pty::AttachRequest,
    ) -> Result<(), Error> {
        // The command channel is registered BEFORE the first remote await: a session_close that
        // lands while the prologue is still talking to the host queues its Detach (and drops the
        // sender), so the driver detaches the moment the attach is acknowledged instead of
        // leaving a ghost attachment no one can reach.
        let (tx, rx) = mpsc::channel::<crate::pty::SessionCmd>(256);
        self.sessions.lock().await.insert(id.clone(), tx);
        let opened = async {
            let channel = self.open_streamlocal(&socket_path).await?;
            // The shell's working directory lives under the box user's home too; expand `~` so a
            // create doesn't fail spawning in a directory that only exists on the client.
            if let Some(spec) = req.create.as_mut() {
                spec.cwd = self.resolve_path(&spec.cwd).await?;
            }
            crate::pty::attach(channel.into_stream(), &req).await.map_err(Error::from)
        }
        .await;
        let stream = match opened {
            Ok(stream) => stream,
            Err(error) => {
                self.sessions.lock().await.remove(&id);
                return Err(error);
            }
        };

        let sessions = self.sessions.clone();
        let cleanup_id = id.clone();
        let emitter = app.clone();
        let data_ev = format!("session://data/{id}");
        let exit_ev = format!("session://exit/{id}");
        let meta_ev = format!("session://meta/{id}");
        let exit_on_error = exit_ev.clone();
        tokio::spawn(async move {
            // Replay markers ride the DATA channel: a mid-stream resync must reset the client
            // terminal *before* the snapshot bytes land, and only one ordered channel can
            // guarantee that sequencing.
            let on_event = |event: crate::pty::SessionEvent| {
                use crate::pty::SessionEvent;
                match event {
                    SessionEvent::Output(bytes) => {
                        let _ = emitter
                            .emit(&data_ev, serde_json::json!({ "kind": "bytes", "data": bytes }));
                    }
                    SessionEvent::Replaying { safe } => {
                        let _ = emitter
                            .emit(&data_ev, serde_json::json!({ "kind": "replay-begin", "safe": safe }));
                    }
                    SessionEvent::ReplayDone => {
                        let _ = emitter.emit(&data_ev, serde_json::json!({ "kind": "replay-end" }));
                    }
                    SessionEvent::Ended(reason) => {
                        let _ = emitter
                            .emit(&exit_ev, serde_json::json!({ "class": "ended", "reason": reason }));
                    }
                    other => {
                        let _ = emitter.emit(&meta_ev, session_meta(&other));
                    }
                }
            };
            if let Err(e) = crate::pty::run(stream, rx, on_event).await {
                let _ = app.emit(
                    &exit_on_error,
                    serde_json::json!({ "class": end_class(&e), "reason": e.to_string() }),
                );
            }
            // Evict the id whether the session ended on its own, detached, or the
            // transport failed — the map must not keep a sender to a dead driver.
            sessions.lock().await.remove(&cleanup_id);
        });
        Ok(())
    }

    async fn send_session(&self, id: &str, cmd: crate::pty::SessionCmd) -> Result<(), Error> {
        // Clone the sender and drop the map lock before awaiting the send: a full
        // channel must never hold the lock and stall every other session's writes.
        let tx = {
            let sessions = self.sessions.lock().await;
            sessions.get(id).cloned().ok_or_else(|| Error::NoSession(id.into()))?
        };
        tx.send(cmd).await.map_err(|_| Error::NoSession(id.into()))
    }

    pub async fn session_write(&self, id: &str, data: Vec<u8>) -> Result<(), Error> {
        self.send_session(id, crate::pty::SessionCmd::Input(data)).await
    }

    pub async fn session_resize(&self, id: &str, cols: u32, rows: u32) -> Result<(), Error> {
        self.send_session(id, crate::pty::SessionCmd::Resize { cols, rows }).await
    }

    pub async fn session_take_write(&self, id: &str) -> Result<(), Error> {
        self.send_session(id, crate::pty::SessionCmd::TakeWrite).await
    }

    pub async fn session_close(&self, id: &str) -> Result<(), Error> {
        let _ = self.send_session(id, crate::pty::SessionCmd::Detach).await;
        self.sessions.lock().await.remove(id);
        Ok(())
    }

    /// Lists the host's sessions over its own streamlocal channel, draining every page.
    pub async fn session_list(
        &self,
        socket_path: String,
        token: String,
    ) -> Result<crate::pty::Listing, Error> {
        let channel = self.open_streamlocal(&socket_path).await?;
        crate::pty::list_sessions(channel.into_stream(), &token)
            .await
            .map_err(|e| Error::PtySession(e.to_string()))
    }

    /// A one-shot control request (kill/create) over its own streamlocal channel.
    pub async fn session_control(
        &self,
        socket_path: String,
        token: String,
        request: crate::pty::Frame,
    ) -> Result<crate::pty::Frame, Error> {
        let channel = self.open_streamlocal(&socket_path).await?;
        crate::pty::control(channel.into_stream(), &token, request)
            .await
            .map_err(|e| Error::PtySession(e.to_string()))
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

    async fn open_sftp(&self, target: &str) -> Result<SftpSession, Error> {
        // Bound the whole handshake: if the container's sshd has no sftp
        // subsystem (or it never answers), SftpSession::new would hang forever
        // and the tree would sit on the skeleton. Surface a clear error instead.
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            let channel = self.container_channel(target).await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream())
                .await
                .map_err(|e| Error::Sftp(e.to_string()))?;
            self.sftp_opens.fetch_add(1, Ordering::Relaxed);
            Ok(sftp)
        })
        .await
        .map_err(|_| Error::Sftp(format!("{target}: SFTP timed out (is the sftp subsystem enabled?)")))?
    }

    /// The pooled SFTP session for a target, opening (and caching) it on first
    /// use. Mirrors `container_session`: a concurrent first-call race just
    /// dials twice and keeps the last insert.
    async fn sftp_session(&self, target: &str) -> Result<Arc<SftpSession>, Error> {
        if let Some(sftp) = self.sftp_pool.lock().await.get(target).cloned() {
            return Ok(sftp);
        }
        let sftp = Arc::new(self.open_sftp(target).await?);
        self.sftp_pool.lock().await.insert(target.to_string(), sftp.clone());
        Ok(sftp)
    }

    /// Drop a stale session from the pool — but only if the pool still holds
    /// *this* session, so a concurrent caller's fresh redial isn't evicted.
    async fn evict_sftp(&self, target: &str, stale: &Arc<SftpSession>) {
        let mut pool = self.sftp_pool.lock().await;
        if pool.get(target).is_some_and(|current| Arc::ptr_eq(current, stale)) {
            pool.remove(target);
        }
    }

    /// Run one SFTP operation on the pooled session, evicting and redialing
    /// once if the transport has died (container restart / idle drop) — the
    /// `container_channel` retry pattern. A `Status` error is the server
    /// answering (no such file, permission denied): the session is healthy, so
    /// it is returned as-is without burning the pool.
    async fn with_sftp<T, F, Fut>(&self, target: &str, op: F) -> Result<T, Error>
    where
        F: Fn(Arc<SftpSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T, SftpError>>,
    {
        let mut last: Option<SftpError> = None;
        for _ in 0..2 {
            let sftp = self.sftp_session(target).await?;
            match op(sftp.clone()).await {
                Ok(value) => return Ok(value),
                Err(e @ SftpError::Status(_)) => return Err(Error::Sftp(e.to_string())),
                Err(e) => {
                    self.evict_sftp(target, &sftp).await;
                    last = Some(e);
                }
            }
        }
        Err(Error::Sftp(last.expect("two attempts ran").to_string()))
    }

    /// A healthy pooled SFTP session for a long transfer: one cheap probe heals
    /// a dead cache entry via the usual evict-and-redial before any bytes move.
    async fn transfer_sftp(&self, target: &str) -> Result<Arc<SftpSession>, Error> {
        self.with_sftp(target, |sftp| async move {
            sftp.canonicalize(".").await?;
            Ok(sftp)
        })
        .await
    }

    /// Run one *mutating* SFTP operation. The read-only probe in
    /// `transfer_sftp` heals a dead pooled session first, but the mutation
    /// itself is never replayed: a transport failure mid-request doesn't prove
    /// the server didn't apply it, so a blind retry could report a false error
    /// (rename/mkdir already applied) or re-truncate a file the first attempt
    /// saved. A failed session is still evicted so the next call redials.
    async fn mutate_sftp<T, F, Fut>(&self, target: &str, op: F) -> Result<T, Error>
    where
        F: FnOnce(Arc<SftpSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T, SftpError>>,
    {
        let sftp = self.transfer_sftp(target).await?;
        match op(sftp.clone()).await {
            Ok(value) => Ok(value),
            Err(e) => {
                if !matches!(e, SftpError::Status(_)) {
                    self.evict_sftp(target, &sftp).await;
                }
                Err(Error::Sftp(e.to_string()))
            }
        }
    }

    /// List a directory in a container over SFTP, resolving an empty path to the
    /// login directory. Dirs first, then case-insensitive by name.
    pub async fn fs_list(&self, target: &str, path: Option<String>) -> Result<FsListing, Error> {
        self.with_sftp(target, |sftp| {
            let path = path.clone();
            async move {
                let dir = resolve_dir(&sftp, path).await?;
                read_listing(&sftp, &dir).await
            }
        })
        .await
    }

    /// Walk a bounded subtree in one invoke: listings for the root and every
    /// reachable directory down to `depth` levels, stopping (with `truncated`
    /// set — never silently) once including another directory would cross the
    /// `max_entries` budget. The budget also caps the root itself, so no
    /// single directory can balloon the response — but a capped root pages:
    /// `after` resumes past the last delivered root entry (by sort key, so a
    /// directory that changed between pages never skips survivors) and
    /// `next_cursor` says where the page after this one starts, so every
    /// entry stays reachable. Heavy dependency/build
    /// directories (`PRUNED_DIRS`) are listed as entries but never descended
    /// into; an unreadable subdirectory is skipped rather than sinking the
    /// whole walk, while an unreadable root still fails loud.
    pub async fn fs_list_deep(
        &self,
        target: &str,
        path: Option<String>,
        depth: u32,
        max_entries: usize,
        after: Option<PageCursor>,
    ) -> Result<DeepListing, Error> {
        if depth == 0 || max_entries == 0 {
            return Err(Error::Sftp("fs_list_deep needs depth >= 1 and max_entries >= 1".into()));
        }
        self.with_sftp(target, |sftp| {
            let path = path.clone();
            let after = after.clone();
            async move {
                let root = resolve_dir(&sftp, path).await?;
                let mut budget = WalkBudget::new(max_entries);
                let mut root_listing = read_listing(&sftp, &root).await?;
                let next_cursor = budget.admit_root(after.as_ref(), &mut root_listing.entries);
                let mut level_dirs = if depth > 1 { child_dirs(&root_listing) } else { Vec::new() };
                let mut listings = vec![root_listing];
                let mut level = 2u32;
                'walk: while level <= depth && !level_dirs.is_empty() {
                    let mut next_level = Vec::new();
                    for batch in level_dirs.chunks(DEEP_LIST_CONCURRENCY) {
                        for result in read_batch(&sftp, batch).await {
                            let listing = match result {
                                Ok(listing) => listing,
                                Err(SftpError::Status(_)) => continue,
                                Err(e) => return Err(e),
                            };
                            if !budget.admit(&listing.entries) {
                                break 'walk;
                            }
                            if level < depth {
                                next_level.extend(child_dirs(&listing));
                            }
                            listings.push(listing);
                        }
                    }
                    level_dirs = next_level;
                    level += 1;
                }
                Ok(DeepListing {
                    listings,
                    truncated: budget.truncated,
                    next_cursor,
                })
            }
        })
        .await
    }

    /// Metadata for one remote path: viewer routing (dir vs file) and read-cap
    /// gating.
    pub async fn fs_stat(&self, target: &str, path: String) -> Result<FsStat, Error> {
        self.with_sftp(target, |sftp| {
            let path = path.clone();
            async move {
                let meta = sftp.metadata(path).await?;
                Ok(FsStat {
                    is_dir: meta.is_dir(),
                    size: meta.len(),
                    modified: meta.mtime.map(u64::from),
                })
            }
        })
        .await
    }

    /// Download a file's bytes from a container (pull / open), refusing —
    /// loudly, never by truncating — anything over `max_bytes`, so a stray
    /// click on a huge file fails fast instead of buffering it whole. The stat
    /// is only a fast preflight: the read itself stops at the cap, so a file
    /// that grows (or a server that understates its size) can't balloon memory.
    pub async fn fs_read(&self, target: &str, path: String, max_bytes: u64) -> Result<Vec<u8>, Error> {
        let stat = self.fs_stat(target, path.clone()).await?;
        if stat.size > max_bytes {
            return Err(Error::TooLarge { path, size: stat.size, max: max_bytes });
        }
        let data = self
            .with_sftp(target, |sftp| {
                let path = path.clone();
                async move { read_capped(&sftp, path, max_bytes).await }
            })
            .await?;
        if data.len() as u64 > max_bytes {
            return Err(Error::TooLarge { path, size: stat.size.max(data.len() as u64), max: max_bytes });
        }
        Ok(data)
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
        let sftp = self.transfer_sftp(target).await?;
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
        // Every top-level path lands at base/<name>, where <name> is the first
        // free variant of its basename ("x", "x (1)", …) — checked against
        // both the disk and this request's other roots (case-insensitively,
        // for the default macOS filesystem) — so a download never lands on top
        // of something already there. Reservations are atomic, never
        // check-then-use: a top-level file is `create_new` in run_download,
        // and a top-level directory is claimed here with `create_dir`, so two
        // concurrent downloads of the same folder land side by side instead of
        // merging into one.
        let sftp = self.transfer_sftp(target).await?;
        tokio::fs::create_dir_all(&base).await?;
        let mut taken = HashSet::new();
        let mut roots: Vec<(String, PathBuf)> = Vec::new();
        for remote in &remote_paths {
            let meta =
                sftp.metadata(remote.clone()).await.map_err(|e| Error::Sftp(e.to_string()))?;
            let local =
                pick_free_local(&base, base_name(remote), &mut taken, meta.is_dir()).await?;
            roots.push((remote.clone(), local));
        }
        let landed: Vec<String> =
            roots.iter().map(|(_, local)| local.to_string_lossy().into_owned()).collect();

        let plan = plan_download(&sftp, &roots).await?;

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

    /// Create a new empty file, failing if the path already exists. One atomic
    /// CREATE|EXCLUDE open — unlike stat-then-write, "new file" can never
    /// truncate something that appeared (or was misdiagnosed as absent by a
    /// transient stat error) in between.
    pub async fn fs_create_file(&self, target: &str, path: String) -> Result<(), Error> {
        self.mutate_sftp(target, |sftp| async move {
            sftp.open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
                .await
                .map(drop)
        })
        .await
    }

    /// Overwrite a remote file with `contents` (editor save).
    pub async fn fs_write(&self, target: &str, path: String, contents: Vec<u8>) -> Result<(), Error> {
        self.mutate_sftp(target, |sftp| async move {
            let mut file = sftp.create(&path).await?;
            file.write_all(&contents).await?;
            file.flush().await?;
            Ok(())
        })
        .await
    }

    /// Editor save with the conflict guard as a remote compare-and-swap: the
    /// new bytes land in a sibling temp file over SFTP, then one shell
    /// invocation on the target host — holding an exclusive `flock` on the
    /// file — byte-compares it against the `expected` baseline (streamed on
    /// stdin to `cmp`) and, only on a match, renames the temp over it. The
    /// rename is the single linearization point: readers never see a torn
    /// write, checked saves serialize on the lock so exactly one of two
    /// concurrent saves wins, and there is no client round-trip between check
    /// and swap for an agent's edit to slip into. A writer that bypasses the
    /// lock (an agent using plain tools) can still race the sub-millisecond
    /// on-host window — no client-side scheme can close that without every
    /// writer going through one versioned channel. The path is canonicalized
    /// first so a save through a symlink lands the temp file beside the link's
    /// *target* and the rename updates that target — a rename over the link's
    /// own pathname would replace the link with an unrelated regular file.
    /// Exit codes: 0 saved, 3 conflict (baseline mismatch, or the file was
    /// deleted), else error; every non-saved outcome removes the temp file —
    /// the shell does it on-host, and a transport failure that prevents the
    /// command from reporting back triggers a best-effort SFTP removal here.
    pub async fn fs_write_checked(
        &self,
        target: &str,
        path: String,
        expected: Vec<u8>,
        contents: Vec<u8>,
    ) -> Result<WriteOutcome, Error> {
        let path = self
            .with_sftp(target, |sftp| {
                let path = path.clone();
                async move { sftp.canonicalize(path).await }
            })
            .await?;
        let tmp = save_tmp_path(&path);
        {
            let tmp = tmp.clone();
            self.mutate_sftp(target, |sftp| async move {
                let mut file = sftp
                    .open_with_flags(tmp, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
                    .await?;
                file.write_all(&contents).await?;
                file.flush().await?;
                Ok(())
            })
            .await?;
        }
        let command = format!(
            "( [ -e {p} ] || exit 3; exec 9<{p} && flock -x 9 || exit 4; \
             if cmp -s -- {p} -; then chmod --reference={p} {t} 2>/dev/null; mv -f -- {t} {p}; \
             else exit 3; fi ); s=$?; [ \"$s\" -eq 0 ] || rm -f -- {t}; exit \"$s\"",
            p = shell_single_quote(&path),
            t = shell_single_quote(&tmp),
        );
        let status = match self.exec_capture_with_input(target, &command, &expected).await {
            Ok(status) => status,
            Err(e) => {
                let tmp = tmp.clone();
                let _ = self
                    .mutate_sftp(target, |sftp| async move { sftp.remove_file(tmp).await })
                    .await;
                return Err(e);
            }
        };
        match status {
            (0, _) => Ok(WriteOutcome::Saved),
            (3, _) => Ok(WriteOutcome::Conflict),
            (code, stderr) => Err(Error::Sftp(if stderr.is_empty() {
                format!("checked save exited with status {code}")
            } else {
                stderr
            })),
        }
    }

    pub async fn fs_rename(&self, target: &str, from: String, to: String) -> Result<(), Error> {
        self.mutate_sftp(target, |sftp| async move { sftp.rename(from, to).await }).await
    }

    pub async fn fs_mkdir(&self, target: &str, path: String) -> Result<(), Error> {
        self.mutate_sftp(target, |sftp| async move { sftp.create_dir(path).await }).await
    }

    /// Delete a file, or a directory and everything under it.
    /// Delete a path with a single `rm -rf` over an exec channel — one round-trip
    /// where the remote shell does the recursion, instead of thousands of
    /// sequential SFTP `remove_file` calls (which froze the UI on big trees). A
    /// `transfer` event (kind `delete`) brackets it so the UI shows a live
    /// indicator and a clean pass/fail. The path is single-quoted and preceded
    /// by `--`, so no path content can inject shell or be read as an option.
    pub async fn fs_delete(
        &self,
        app: &AppHandle,
        target: &str,
        path: String,
        transfer_id: String,
    ) -> Result<(), Error> {
        if path.is_empty() || path == "/" {
            return Err(Error::Sftp("refusing to delete an empty or root path".into()));
        }
        let label = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(&path).to_string();
        let mut progress = TransferProgress::start(transfer_id, "delete", label, 0, 0);
        emit_transfer(app, &progress);

        let command = format!("rm -rf -- {}", shell_single_quote(&path));
        let outcome = self.exec_capture(target, &command).await;
        let result = match outcome {
            Ok((0, _)) => Ok(()),
            Ok((code, stderr)) => Err(Error::Sftp(if stderr.is_empty() {
                format!("rm exited with status {code}")
            } else {
                stderr
            })),
            Err(e) => Err(e),
        };
        match &result {
            Ok(()) => progress.status = "done",
            Err(e) => {
                progress.status = "error";
                progress.detail = Some(e.to_string());
            }
        }
        emit_transfer(app, &progress);
        result
    }

    /// Run one command on a container's session to completion, returning its
    /// exit status and captured stderr. Used for `rm -rf`; keeps the channel
    /// bounded so a wedged remote can't hang the delete forever.
    async fn exec_capture(&self, target: &str, command: &str) -> Result<(u32, String), Error> {
        self.exec_capture_with_input(target, command, &[]).await
    }

    /// `exec_capture` with bytes streamed to the command's stdin. The send is
    /// best-effort — a command that decides early (cmp on a first-byte
    /// mismatch) may close stdin before it's fully written — so the exit
    /// status is the only verdict: a channel that closes without reporting one
    /// is an error, never a default success.
    async fn exec_capture_with_input(
        &self,
        target: &str,
        command: &str,
        input: &[u8],
    ) -> Result<(u32, String), Error> {
        tokio::time::timeout(EXEC_TIMEOUT, async {
            let mut channel = self.container_channel(target).await?;
            channel.exec(true, command.as_bytes()).await?;
            if !input.is_empty() {
                let _ = channel.data(input).await;
            }
            let _ = channel.eof().await;
            let mut exit = None;
            let mut stderr = Vec::new();
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
            let exit = exit.ok_or_else(|| {
                Error::Sftp(format!("remote command closed without an exit status: {stderr}"))
            })?;
            Ok((exit, stderr))
        })
        .await
        .map_err(|_| Error::Sftp(format!("{target}: remote command timed out")))?
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
        if let Some(token) = self.token.lock().await.as_deref() {
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

    /// Open a long-lived HTTP GET to the control plane and stream its body to the
    /// webview as it arrives — the read counterpart to `sail_request`, for SSE
    /// tails (`/v1/events/stream`, `/v1/runs/{id}/stream`). The bearer
    /// token is injected here so it never reaches the webview; the response body
    /// is de-chunked in flight and emitted line-boundaried as `stream://data/{id}`
    /// text, with `stream://open/{id}` (status) up front and `stream://end/{id}`
    /// ({error?}) when the read ends. The webview parses the SSE framing and owns
    /// reconnect/cursor, calling back in with a fresh `since`.
    pub async fn stream_open(&self, app: AppHandle, id: String, path: String) -> Result<(), Error> {
        // The request line is built by hand, so `path` is a trust boundary —
        // validate before it reaches the wire (and before we even dial).
        validate_stream_path(&path)?;
        let channel = self
            .open_forward(&self.config.server_host, self.config.server_port)
            .await?;
        let mut stream = channel.into_stream();

        let mut req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\n",
            host = self.config.server_host,
            port = self.config.server_port,
        );
        if let Some(token) = self.token.lock().await.as_deref() {
            req.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        req.push_str("\r\n");
        stream.write_all(req.as_bytes()).await?;
        stream.flush().await?;

        // Read just the response head; the bytes past `\r\n\r\n` begin the body.
        // Bound it: if the peer accepts the connection but stalls before the head
        // completes, the command must fail deterministically rather than hang
        // uncancelably (the cancel channel isn't registered until after this).
        let mut head = Vec::new();
        let mut tmp = [0u8; 4096];
        let split = tokio::time::timeout(REQUEST_TIMEOUT, async {
            loop {
                if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Ok(pos);
                }
                if head.len() > 64 * 1024 {
                    break Err(Error::BadResponse);
                }
                let n = stream.read(&mut tmp).await?;
                if n == 0 {
                    break Err(Error::BadResponse);
                }
                head.extend_from_slice(&tmp[..n]);
            }
        })
        .await
        .map_err(|_| Error::Timeout(format!("{}:{}", self.config.server_host, self.config.server_port)))??;
        let leftover = head.split_off(split + 4);
        let head_text = String::from_utf8_lossy(&head);
        let status = status_line_code(&head_text).ok_or(Error::BadResponse)?;
        let chunked = header_is_chunked(&head_text);

        let _ = app.emit(&format!("stream://open/{id}"), json!({ "status": status }));

        let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
        self.streams.lock().await.insert(id.clone(), cancel_tx);

        let data_event = format!("stream://data/{id}");
        let end_event = format!("stream://end/{id}");
        tokio::spawn(async move {
            let mut dechunker = Dechunker::new(chunked);
            let mut pending: Vec<u8> = Vec::new();
            emit_stream_text(&app, &data_event, &mut pending, dechunker.feed(&leftover), false);

            let error = loop {
                let mut chunk = [0u8; 8192];
                tokio::select! {
                    _ = cancel_rx.recv() => break None,
                    read = stream.read(&mut chunk) => match read {
                        Ok(0) => break None,
                        Ok(n) => {
                            let decoded = dechunker.feed(&chunk[..n]);
                            emit_stream_text(&app, &data_event, &mut pending, decoded, false);
                        }
                        Err(e) => break Some(e.to_string()),
                    },
                }
            };
            // Flush any trailing partial line so the last frame isn't stranded.
            emit_stream_text(&app, &data_event, &mut pending, Vec::new(), true);
            let _ = app.emit(&end_event, json!({ "error": error }));
        });
        Ok(())
    }

    /// Stop a live stream: signal its pump to end. Idempotent.
    pub async fn stream_close(&self, id: &str) -> Result<(), Error> {
        if let Some(tx) = self.streams.lock().await.remove(id) {
            let _ = tx.send(()).await;
        }
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

/// Status code from an HTTP response head's first line (`HTTP/1.1 200 OK`).
fn status_line_code(head: &str) -> Option<u16> {
    head.lines().next()?.split_whitespace().nth(1)?.parse().ok()
}

/// Whether the response head advertises chunked transfer encoding.
fn header_is_chunked(head: &str) -> bool {
    head.lines().skip(1).any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    })
}

/// Append decoded body bytes, emit everything up to the last newline as one
/// text chunk (so the webview's SSE parser only sees line-boundaried input and
/// no UTF-8 char is split mid-emit), and keep the trailing partial line
/// buffered. `flush` forces the remainder out when the stream ends.
fn emit_stream_text(app: &AppHandle, event: &str, pending: &mut Vec<u8>, decoded: Vec<u8>, flush: bool) {
    pending.extend_from_slice(&decoded);
    let upto = if flush {
        pending.len()
    } else {
        pending.iter().rposition(|&b| b == b'\n').map_or(0, |pos| pos + 1)
    };
    if upto == 0 {
        return;
    }
    let text = String::from_utf8_lossy(&pending[..upto]).into_owned();
    pending.drain(..upto);
    if !text.is_empty() {
        let _ = app.emit(event, text);
    }
}

#[derive(Clone, Copy)]
enum ChunkState {
    Size,
    Data(usize),
    Trailer,
    Done,
}

/// Decodes HTTP/1.1 chunked transfer framing incrementally across arbitrarily
/// split reads (SSE bodies arrive a few bytes at a time). A passthrough when the
/// response isn't chunked; malformed framing stops decoding, mirroring the
/// whole-buffer `dechunk`.
struct Dechunker {
    chunked: bool,
    buf: Vec<u8>,
    state: ChunkState,
}

impl Dechunker {
    fn new(chunked: bool) -> Self {
        Dechunker {
            chunked,
            buf: Vec::new(),
            state: if chunked { ChunkState::Size } else { ChunkState::Done },
        }
    }

    fn feed(&mut self, input: &[u8]) -> Vec<u8> {
        if !self.chunked {
            return input.to_vec();
        }
        self.buf.extend_from_slice(input);
        let mut out = Vec::new();
        loop {
            match self.state {
                ChunkState::Size => {
                    let Some(eol) = self.buf.windows(2).position(|w| w == b"\r\n") else {
                        break;
                    };
                    let size_line = String::from_utf8_lossy(&self.buf[..eol]);
                    let size = usize::from_str_radix(
                        size_line.trim().split(';').next().unwrap_or("").trim(),
                        16,
                    );
                    self.buf.drain(..eol + 2);
                    self.state = match size {
                        Ok(0) | Err(_) => ChunkState::Done,
                        Ok(n) => ChunkState::Data(n),
                    };
                }
                ChunkState::Data(remaining) => {
                    if self.buf.is_empty() {
                        break;
                    }
                    let take = remaining.min(self.buf.len());
                    out.extend(self.buf.drain(..take));
                    let left = remaining - take;
                    self.state = if left == 0 {
                        ChunkState::Trailer
                    } else {
                        ChunkState::Data(left)
                    };
                }
                ChunkState::Trailer => {
                    if self.buf.len() < 2 {
                        break;
                    }
                    self.buf.drain(..2);
                    self.state = ChunkState::Size;
                }
                ChunkState::Done => break,
            }
        }
        out
    }
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

/// An empty/absent path means the login directory.
async fn resolve_dir(sftp: &SftpSession, path: Option<String>) -> Result<String, SftpError> {
    match path {
        Some(p) if !p.is_empty() => Ok(p),
        _ => sftp.canonicalize(".").await,
    }
}

/// One directory's entries in the shape every listing shares: no dot entries,
/// dirs first, then case-insensitive by name.
async fn read_listing(sftp: &SftpSession, dir: &str) -> Result<FsListing, SftpError> {
    let read = sftp.read_dir(dir.to_string()).await?;
    let mut entries: Vec<FileEntry> = read
        .filter(|e| e.file_name() != "." && e.file_name() != "..")
        .map(|e| {
            let meta = e.metadata();
            let name = e.file_name();
            FileEntry {
                path: join_remote(dir, &name),
                name,
                is_dir: meta.is_dir(),
                size: meta.len(),
            }
        })
        .collect();
    sort_entries(&mut entries);
    Ok(FsListing { path: dir.to_string(), entries })
}

/// The subdirectories the deep walker descends into from one listing.
fn child_dirs(listing: &FsListing) -> Vec<String> {
    listing
        .entries
        .iter()
        .filter(|e| e.is_dir && !is_pruned(&e.name))
        .map(|e| e.path.clone())
        .collect()
}

/// List one batch of directories concurrently over the shared session,
/// returning results in the batch's order so budget admission (and therefore
/// truncation) stays deterministic. The caller sizes batches to
/// `DEEP_LIST_CONCURRENCY`.
async fn read_batch(sftp: &Arc<SftpSession>, dirs: &[String]) -> Vec<Result<FsListing, SftpError>> {
    let mut tasks = tokio::task::JoinSet::new();
    for (index, dir) in dirs.iter().enumerate() {
        let sftp = sftp.clone();
        let dir = dir.clone();
        tasks.spawn(async move { (index, read_listing(&sftp, &dir).await) });
    }
    let mut results: Vec<Option<Result<FsListing, SftpError>>> = dirs.iter().map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        let (index, result) = joined.expect("deep-walk listing task panicked");
        results[index] = Some(result);
    }
    results.into_iter().map(|r| r.expect("every batch index joined")).collect()
}

/// The listing order — dirs first, case-insensitive by name, exact name as the
/// tiebreak so the order is total — doubling as the page-cursor comparison key:
/// `PageCursor` carries (is_dir, name) and "ordered after the cursor" is
/// exactly "sorts after the last delivered entry".
fn entry_sort_key(is_dir: bool, name: &str) -> (bool, String, String) {
    (!is_dir, name.to_lowercase(), name.to_string())
}

fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by_cached_key(|e| entry_sort_key(e.is_dir, &e.name));
}

/// Exact-name match against the deep walker's prune list.
fn is_pruned(name: &str) -> bool {
    PRUNED_DIRS.contains(&name)
}

/// Read at most `max_bytes` + 1 detection byte, streaming through `take` so an
/// oversized (or concurrently growing) file is never buffered whole. A result
/// longer than `max_bytes` means "over the cap" — the caller turns it into the
/// typed `TooLarge` error.
async fn read_capped(sftp: &SftpSession, path: String, max_bytes: u64) -> Result<Vec<u8>, SftpError> {
    let file = sftp.open(&path).await?;
    let mut data = Vec::new();
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut data).await?;
    Ok(data)
}

/// The deep walker's total-entry budget: a descendant listing is admitted whole
/// or not at all (a partial listing would poison the webview's cache as if
/// complete), and every cut marks the result truncated. The walk root is
/// special-cased the other way: the directory the user actually opened always
/// returns, but paged at the budget — one huge (or hostile) directory must not
/// push an unbounded listing into the webview, yet every entry stays reachable
/// through the returned continuation cursor.
struct WalkBudget {
    remaining: usize,
    truncated: bool,
}

impl WalkBudget {
    fn new(max_entries: usize) -> Self {
        WalkBudget { remaining: max_entries, truncated: false }
    }

    /// Page the root listing (already in `sort_entries` order): keep the first
    /// budget-worth of entries ordered after `after`, and return the cursor
    /// the next page resumes from (None = done). Cursoring by sort key rather
    /// than a count means entries inserted or deleted before the cut between
    /// requests shift nothing — nothing already delivered repeats, nothing
    /// undelivered is skipped (short of being renamed behind the cursor).
    fn admit_root(&mut self, after: Option<&PageCursor>, entries: &mut Vec<FileEntry>) -> Option<PageCursor> {
        let mut page: Vec<FileEntry> = std::mem::take(entries)
            .into_iter()
            .filter(|e| {
                after.is_none_or(|c| entry_sort_key(e.is_dir, &e.name) > entry_sort_key(c.is_dir, &c.name))
            })
            .collect();
        let has_more = page.len() > self.remaining;
        page.truncate(self.remaining);
        self.remaining -= page.len();
        let next = has_more.then(|| {
            let last = page.last().expect("the root budget is at least 1, so a cut page is non-empty");
            PageCursor { is_dir: last.is_dir, name: last.name.clone() }
        });
        *entries = page;
        if next.is_some() {
            self.truncated = true;
        }
        next
    }

    fn admit(&mut self, entries: &[FileEntry]) -> bool {
        if entries.len() > self.remaining {
            self.truncated = true;
            return false;
        }
        self.remaining -= entries.len();
        true
    }
}

fn base_name(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// A dotted sibling temp path for a checked save — same directory, so the
/// final rename is same-filesystem and atomic. The pid+nanos suffix keeps
/// concurrent saves (and leftovers from a crashed one) from colliding on the
/// exclusive create.
fn save_tmp_path(path: &str) -> String {
    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{dir}/.{name}.mast-save-{}-{nanos}", std::process::id())
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

/// First free name for a download landing in `base`: the basename itself, then
/// "name (1)", "name (2)", … before the final extension — probed against the
/// filesystem and against `taken` (lowercased: this request's earlier picks).
/// With `reserve_dir` the winning name is claimed on the spot with an atomic
/// `create_dir` — a concurrent download racing for the same folder loses the
/// create and moves on to the next candidate, so two requests can never merge
/// into one directory. Files skip the reservation; `create_new` in
/// run_download is their atomic claim.
async fn pick_free_local(
    base: &Path,
    name: &str,
    taken: &mut HashSet<String>,
    reserve_dir: bool,
) -> Result<PathBuf, Error> {
    for n in 0..1000 {
        let candidate = if n == 0 { name.to_string() } else { numbered_name(name, n) };
        if taken.contains(&candidate.to_lowercase()) {
            continue;
        }
        let path = base.join(&candidate);
        if reserve_dir {
            match tokio::fs::create_dir(&path).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        } else if tokio::fs::try_exists(&path).await? {
            continue;
        }
        taken.insert(candidate.to_lowercase());
        return Ok(path);
    }
    Err(Error::Sftp(format!("no free local name for \"{name}\"")))
}

fn numbered_name(name: &str, n: usize) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({n}).{ext}"),
        _ => format!("{name} ({n})"),
    }
}

/// Walk the remote roots (already mapped to their local landing paths) over
/// SFTP into a flat download plan (local dirs are made on the fly by
/// `run_download`). Iterative to avoid boxed async recursion.
async fn plan_download(
    sftp: &SftpSession,
    roots: &[(String, PathBuf)],
) -> Result<DownloadPlan, Error> {
    let mut plan = DownloadPlan::default();
    let mut stack: Vec<(String, PathBuf)> = roots.to_vec();
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
        let mut dst = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&item.local)
            .await
            .map_err(|e| Error::Sftp(format!("{}: {e}", item.local.display())))?;
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

/// Single-quote a string for safe interpolation into a POSIX shell command: wrap
/// in `'…'` and replace each embedded `'` with `'\''`. Everything else is literal
/// inside single quotes, so no path content can break out or inject.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Gate the request target for `stream_open`, which formats it straight into an
/// HTTP request line. Requires origin form, allow-lists exactly the two SSE
/// routes (their query strings included), and rejects any whitespace/control
/// byte — so a CRLF-laden path can't split the request or inject headers.
fn validate_stream_path(path: &str) -> Result<(), Error> {
    let route_ok = path.starts_with("/v1/events/stream")
        || (path.starts_with("/v1/runs/") && path.contains("/stream"));
    let bytes_ok = path.starts_with('/') && !path.bytes().any(|b| b <= 0x20 || b == 0x7f);
    if route_ok && bytes_ok {
        Ok(())
    } else {
        Err(Error::BadStreamPath)
    }
}

/// Set (or, with `None`, remove) the `token:` field in `~/.sail/config.yaml`,
/// preserving the other keys and the file's flow-vs-block YAML style, written
/// 0600. Mirrors the CLI's writeConfig so Mast and `sail` stay in sync.
pub fn write_config_token(token: Option<&str>) -> Result<(), Error> {
    let home = dirs::home_dir().ok_or(Error::NoConfig)?;
    let path = home.join(".sail/config.yaml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let trimmed = existing.trim();

    let quote = |v: &str| {
        if v.chars().any(|c| ":#,{}[]".contains(c)) {
            format!("'{v}'")
        } else {
            v.to_string()
        }
    };

    let content = if trimmed.starts_with('{') && trimmed.ends_with('}') {
        let mut pairs: Vec<(String, String)> = split_flow(&trimmed[1..trimmed.len() - 1])
            .into_iter()
            .filter_map(|part| {
                let colon = part.find(':')?;
                if colon == 0 {
                    return None;
                }
                let key = part[..colon].trim().to_string();
                let val = part[colon + 1..].trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                Some((key, val))
            })
            .filter(|(k, _)| k != "token")
            .collect();
        if let Some(t) = token {
            pairs.push(("token".into(), t.to_string()));
        }
        let body = pairs.iter().map(|(k, v)| format!("{k}: {}", quote(v))).collect::<Vec<_>>().join(", ");
        format!("{{{body}}}\n")
    } else {
        let mut lines: Vec<String> = existing
            .lines()
            .filter(|l| !l.trim_start().starts_with("token"))
            .map(str::to_string)
            .collect();
        while lines.last().map_or(false, |l| l.trim().is_empty()) {
            lines.pop();
        }
        if let Some(t) = token {
            lines.push(format!("token: {}", quote(t)));
        }
        format!("{}\n", lines.join("\n"))
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
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

    #[test]
    fn every_hop_probes_the_link_with_keepalives() {
        let cfg = client_config();
        assert_eq!(cfg.keepalive_interval, Some(KEEPALIVE_INTERVAL));
        assert!(cfg.keepalive_max > 0, "unanswered probes must close the session");
    }

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

    #[tokio::test]
    async fn pick_free_local_reserves_directories_atomically() {
        let base = std::env::temp_dir().join(format!("mast_pick_{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();

        let mut taken = HashSet::new();
        let first = pick_free_local(&base, "proj", &mut taken, true).await.unwrap();
        assert!(first.is_dir(), "dir root is claimed on disk at pick time");

        // A concurrent request shares no in-memory state — only the on-disk
        // reservation keeps it from landing in the same folder.
        let mut other = HashSet::new();
        let second = pick_free_local(&base, "proj", &mut other, true).await.unwrap();
        assert_eq!(second.file_name().unwrap().to_str().unwrap(), "proj (1)");
        assert!(second.is_dir());

        let file = pick_free_local(&base, "notes.txt", &mut other, false).await.unwrap();
        assert!(!file.exists(), "files are claimed later by create_new");

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
    fn dechunker_passthrough_when_not_chunked() {
        let mut d = Dechunker::new(false);
        assert_eq!(d.feed(b"id: 1\ndata: hello\n\n"), b"id: 1\ndata: hello\n\n");
    }

    #[test]
    fn dechunker_decodes_a_whole_body() {
        let mut d = Dechunker::new(true);
        assert_eq!(d.feed(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), b"Wikipedia");
    }

    #[test]
    fn dechunker_decodes_across_arbitrary_splits() {
        let mut d = Dechunker::new(true);
        let mut out = Vec::new();
        // The same body as above, fed one to three bytes at a time.
        let raw = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        for byte in raw {
            out.extend(d.feed(&[*byte]));
        }
        assert_eq!(out, b"Wikipedia");
    }

    #[test]
    fn dechunker_streams_each_chunk_as_it_completes() {
        let mut d = Dechunker::new(true);
        // A realistic SSE frame split so the size line and data arrive separately
        // (0x18 = 24 = the byte length of the data payload below).
        assert_eq!(d.feed(b"18\r\n"), b"");
        assert_eq!(d.feed(b"id: 7\ndata: a log line\n\n"), b"id: 7\ndata: a log line\n\n");
        assert_eq!(d.feed(b"\r\n0\r\n\r\n"), b"");
    }

    #[test]
    fn head_helpers_parse_status_and_chunked() {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked";
        assert_eq!(status_line_code(head), Some(200));
        assert!(header_is_chunked(head));
        let plain = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 12";
        assert_eq!(status_line_code(plain), Some(401));
        assert!(!header_is_chunked(plain));
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

        let channel = handle.channel_open_session().await.expect("channel");
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

        // Clean up the populated directory (delete now runs `rm -rf` over an
        // exec channel, which needs a container session, so tidy up via SFTP).
        sftp.remove_file(&nested).await.ok();
        sftp.remove_dir(&subdir).await.ok();
        assert!(sftp.metadata(subdir).await.is_err(), "dir should be gone");
    }

    #[test]
    fn shell_single_quote_neutralises_injection() {
        assert_eq!(shell_single_quote("/a/b"), "'/a/b'");
        // A path trying to break out of the quotes or inject a command stays
        // entirely literal inside the requoting.
        assert_eq!(shell_single_quote("a'; rm -rf /"), "'a'\\''; rm -rf /'");
    }

    #[test]
    fn pruned_dirs_match_whole_names_only() {
        for name in PRUNED_DIRS {
            assert!(is_pruned(name), "{name} should be pruned");
        }
        assert!(!is_pruned("gitignore"));
        assert!(!is_pruned("my.git"));
        assert!(!is_pruned("node_modules_backup"));
        assert!(!is_pruned("src"));
    }

    /// Entries in `sort_entries` order (zero-padded names), as `admit_root`
    /// receives them from `read_listing`.
    fn fixture_entries(n: usize) -> Vec<FileEntry> {
        (0..n)
            .map(|i| FileEntry {
                name: format!("f{i:04}"),
                path: format!("/x/f{i:04}"),
                is_dir: false,
                size: 0,
            })
            .collect()
    }

    fn cursor(name: &str) -> Option<PageCursor> {
        Some(PageCursor { is_dir: false, name: name.into() })
    }

    #[test]
    fn walk_budget_admits_whole_listings_until_the_cap() {
        let mut budget = WalkBudget::new(10);
        assert_eq!(budget.admit_root(None, &mut fixture_entries(4)), None);
        assert!(budget.admit(&fixture_entries(6)));
        assert!(!budget.truncated);
        assert!(!budget.admit(&fixture_entries(1)), "an exhausted budget rejects");
        assert!(budget.truncated);

        let mut budget = WalkBudget::new(10);
        let over = fixture_entries(11);
        assert!(!budget.admit(&over), "a descendant bigger than the budget is rejected whole");
        assert_eq!(over.len(), 11, "and never partially consumed");
        assert!(budget.truncated);
    }

    #[test]
    fn walk_budget_pages_an_oversized_root_listing() {
        let mut budget = WalkBudget::new(10);
        let mut root = fixture_entries(5000);
        let next = budget.admit_root(None, &mut root);
        assert_eq!(next, cursor("f0009"), "the opened directory still lists, with a continuation");
        assert_eq!(root.len(), 10, "but bounded by the budget");
        assert!(budget.truncated, "and the cut is never silent");
        assert!(!budget.admit(&fixture_entries(1)), "the budget is spent for descendants");
    }

    #[test]
    fn walk_budget_root_pages_resume_where_the_last_one_stopped() {
        let mut budget = WalkBudget::new(10);
        let mut middle = fixture_entries(25);
        assert_eq!(budget.admit_root(cursor("f0009").as_ref(), &mut middle), cursor("f0019"));
        assert_eq!(middle.first().map(|e| e.name.as_str()), Some("f0010"));
        assert_eq!(middle.len(), 10);
        assert!(budget.truncated);

        let mut budget = WalkBudget::new(10);
        let mut last = fixture_entries(25);
        assert_eq!(budget.admit_root(cursor("f0019").as_ref(), &mut last), None, "the final page completes");
        assert_eq!(last.len(), 5);
        assert!(!budget.truncated);

        let mut budget = WalkBudget::new(10);
        let mut shrunk = fixture_entries(3);
        assert_eq!(
            budget.admit_root(cursor("f0019").as_ref(), &mut shrunk),
            None,
            "a dir that shrank between pages ends cleanly"
        );
        assert!(shrunk.is_empty());
        assert!(!budget.truncated);
    }

    /// The review's interleaving: [a,b,c,d] pages as [a,b]; `a` is deleted
    /// before the next request. An offset would skip `c` forever — the cursor
    /// delivers every survivor that sorted after the last page.
    #[test]
    fn walk_budget_cursor_never_skips_entries_when_the_directory_shifts() {
        let entry = |name: &str| FileEntry { name: name.into(), path: format!("/x/{name}"), is_dir: false, size: 0 };

        let mut budget = WalkBudget::new(2);
        let mut page1 = vec![entry("a"), entry("b"), entry("c"), entry("d")];
        let next = budget.admit_root(None, &mut page1);
        assert_eq!(next, cursor("b"));

        let mut budget = WalkBudget::new(2);
        let mut page2 = vec![entry("b"), entry("c"), entry("d")];
        assert_eq!(budget.admit_root(next.as_ref(), &mut page2), None);
        let names: Vec<&str> = page2.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["c", "d"], "the survivor after the deletion is still delivered");

        let mut budget = WalkBudget::new(2);
        let mut grown = vec![entry("0new"), entry("a"), entry("b"), entry("c"), entry("d")];
        assert_eq!(budget.admit_root(next.as_ref(), &mut grown), None);
        let names: Vec<&str> = grown.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["c", "d"], "an insertion before the cursor repeats nothing");
    }

    /// Dirs sort before files and the cursor key honors that: resuming after
    /// the last directory starts at the files, never re-listing a dir.
    #[test]
    fn walk_budget_cursor_orders_dirs_before_files() {
        let entry = |name: &str, is_dir: bool| FileEntry {
            name: name.into(),
            path: format!("/x/{name}"),
            is_dir,
            size: 0,
        };
        let listing = || {
            let mut all = vec![entry("zeta", true), entry("alpha.txt", false), entry("Beta", true)];
            sort_entries(&mut all);
            all
        };

        let mut budget = WalkBudget::new(2);
        let mut page1 = listing();
        let next = budget.admit_root(None, &mut page1);
        assert_eq!(next, Some(PageCursor { is_dir: true, name: "zeta".into() }));

        let mut budget = WalkBudget::new(2);
        let mut page2 = listing();
        assert_eq!(budget.admit_root(next.as_ref(), &mut page2), None);
        let names: Vec<&str> = page2.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["alpha.txt"]);
    }

    #[test]
    fn sort_entries_puts_dirs_first_then_case_insensitive_names() {
        let entry = |name: &str, is_dir: bool| FileEntry {
            name: name.into(),
            path: format!("/x/{name}"),
            is_dir,
            size: 0,
        };
        let mut entries = vec![
            entry("zeta.txt", false),
            entry("Beta", true),
            entry("alpha.txt", false),
            entry("gamma", true),
        ];
        sort_entries(&mut entries);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Beta", "gamma", "alpha.txt", "zeta.txt"]);
    }

    /// A Backend aimed at 127.0.0.1 for the live tests below — no
    /// ~/.sail/config.yaml needed.
    fn test_backend() -> Backend {
        Backend {
            config: SailConfig {
                ssh_host: "127.0.0.1".into(),
                fallback_user: None,
                server_host: "127.0.0.1".into(),
                server_port: 7070,
                token: None,
                key_path: None,
            },
            token: Mutex::new(None),
            session: Mutex::new(None),
            containers: Mutex::new(HashMap::new()),
            sftp_pool: Mutex::new(HashMap::new()),
            sftp_opens: AtomicU64::new(0),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            home: Mutex::new(None),
            streams: Mutex::new(HashMap::new()),
        }
    }

    const LOCAL: &str = "127.0.0.1";

    /// rm -rf a test fixture over an exec channel (same path fs_delete uses,
    /// minus the AppHandle progress events).
    async fn cleanup(backend: &Backend, path: &str) {
        let _ = backend
            .exec_capture(LOCAL, &format!("rm -rf -- {}", shell_single_quote(path)))
            .await;
    }

    /// Live: two sequential fs_* calls ride one SFTP subsystem. Needs sshd on
    /// 127.0.0.1:22 accepting $USER via agent or ~/.ssh/id_*; run with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn pooled_sftp_opens_the_subsystem_once_across_calls() {
        let backend = test_backend();
        let first = backend.fs_list(LOCAL, None).await.expect("first list");
        assert!(first.path.starts_with('/'));
        backend.fs_list(LOCAL, Some(first.path.clone())).await.expect("second list");
        backend.fs_stat(LOCAL, first.path).await.expect("stat");
        assert_eq!(backend.sftp_opens.load(Ordering::Relaxed), 1);
    }

    /// Live: killing the SSH session under the pooled SFTP channel is healed by
    /// the next call (evict + redial, one new subsystem open).
    #[tokio::test]
    #[ignore]
    async fn dropped_session_redials_transparently() {
        let backend = test_backend();
        backend.fs_list(LOCAL, None).await.expect("first list");
        let session = backend.containers.lock().await.get(LOCAL).cloned().expect("pooled session");
        session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "test kill", "")
            .await
            .ok();
        let relisted = backend.fs_list(LOCAL, None).await.expect("list after kill");
        assert!(relisted.path.starts_with('/'));
        assert_eq!(backend.sftp_opens.load(Ordering::Relaxed), 2);
    }

    /// Live: a Status error (nonexistent path) is returned as-is and does NOT
    /// burn the pooled session.
    #[tokio::test]
    #[ignore]
    async fn status_errors_do_not_evict_the_pooled_session() {
        let backend = test_backend();
        let home = backend.fs_list(LOCAL, None).await.expect("list").path;
        let missing = join_remote(&home, "mast_definitely_missing_xyz");
        assert!(backend.fs_stat(LOCAL, missing).await.is_err());
        backend.fs_list(LOCAL, Some(home)).await.expect("list still works");
        assert_eq!(backend.sftp_opens.load(Ordering::Relaxed), 1);
    }

    /// Live: fs_list_deep walks a fixture tree — pruning, depth bounding, and
    /// truncation observable, entries identical to fs_list's shape.
    #[tokio::test]
    #[ignore]
    async fn fs_list_deep_prunes_bounds_and_truncates() {
        let backend = test_backend();
        let home = backend.fs_list(LOCAL, None).await.expect("home").path;
        let root = join_remote(&home, "mast_deep_fixture");
        cleanup(&backend, &root).await;

        for dir in [
            root.clone(),
            join_remote(&root, "sub"),
            join_remote(&root, "sub/inner"),
            join_remote(&root, "node_modules"),
        ] {
            backend.fs_mkdir(LOCAL, dir).await.expect("mkdir");
        }
        backend.fs_write(LOCAL, join_remote(&root, "a.txt"), b"aa".to_vec()).await.unwrap();
        backend.fs_write(LOCAL, join_remote(&root, "sub/b.txt"), b"bb".to_vec()).await.unwrap();
        backend.fs_write(LOCAL, join_remote(&root, "sub/inner/c.txt"), b"cc".to_vec()).await.unwrap();
        backend
            .fs_write(LOCAL, join_remote(&root, "node_modules/junk.txt"), b"jj".to_vec())
            .await
            .unwrap();

        let deep = backend
            .fs_list_deep(LOCAL, Some(root.clone()), 3, 2000, None)
            .await
            .expect("deep list");
        assert!(!deep.truncated);
        let listed: Vec<&str> = deep.listings.iter().map(|l| l.path.as_str()).collect();
        assert!(listed.contains(&root.as_str()));
        assert!(listed.contains(&join_remote(&root, "sub").as_str()));
        assert!(listed.contains(&join_remote(&root, "sub/inner").as_str()));
        assert!(
            !listed.contains(&join_remote(&root, "node_modules").as_str()),
            "heavy dirs are not descended into"
        );

        // The pruned dir still shows up as an entry of its parent, and the deep
        // root listing matches fs_list exactly.
        let deep_root = deep.listings.iter().find(|l| l.path == root).unwrap();
        assert!(deep_root.entries.iter().any(|e| e.name == "node_modules" && e.is_dir));
        let flat = backend.fs_list(LOCAL, Some(root.clone())).await.expect("flat list");
        let shape = |l: &FsListing| -> Vec<(String, String, bool, u64)> {
            l.entries
                .iter()
                .map(|e| (e.name.clone(), e.path.clone(), e.is_dir, e.size))
                .collect()
        };
        assert_eq!(shape(deep_root), shape(&flat));

        // Expanding a pruned dir directly lists it normally.
        let direct = backend
            .fs_list_deep(LOCAL, Some(join_remote(&root, "node_modules")), 1, 2000, None)
            .await
            .expect("direct deep list of pruned dir");
        assert_eq!(direct.listings.len(), 1);
        assert!(direct.listings[0].entries.iter().any(|e| e.name == "junk.txt"));

        // Depth bounding: depth 1 returns only the root listing.
        let shallow = backend
            .fs_list_deep(LOCAL, Some(root.clone()), 1, 2000, None)
            .await
            .expect("depth-1 deep list");
        assert_eq!(shallow.listings.len(), 1);
        assert!(!shallow.truncated, "a depth bound is not truncation");

        // Truncation: a budget that only fits the root listing stops there and
        // says so.
        let cut = backend
            .fs_list_deep(LOCAL, Some(root.clone()), 3, deep_root.entries.len(), None)
            .await
            .expect("capped deep list");
        assert!(cut.truncated);
        assert_eq!(cut.listings.len(), 1);
        assert_eq!(cut.listings[0].path, root);

        // Root paging: a budget smaller than the root pages it, and following
        // next_cursor eventually surfaces every entry.
        let page1 = backend
            .fs_list_deep(LOCAL, Some(root.clone()), 1, 2, None)
            .await
            .expect("first root page");
        assert!(page1.truncated);
        assert!(page1.next_cursor.is_some());
        let page2 = backend
            .fs_list_deep(LOCAL, Some(root.clone()), 1, 2, page1.next_cursor.clone())
            .await
            .expect("second root page");
        assert_eq!(page2.next_cursor, None);
        let mut paged: Vec<String> = page1.listings[0]
            .entries
            .iter()
            .chain(page2.listings[0].entries.iter())
            .map(|e| e.name.clone())
            .collect();
        let mut all: Vec<String> = deep_root.entries.iter().map(|e| e.name.clone()).collect();
        paged.sort();
        all.sort();
        assert_eq!(paged, all, "paging loses nothing and duplicates nothing");

        cleanup(&backend, &root).await;
    }

    /// Live: fs_stat reports files and dirs; fs_read enforces the byte cap with
    /// the typed TooLarge error and still round-trips under it.
    #[tokio::test]
    #[ignore]
    async fn fs_stat_and_read_cap_roundtrip() {
        let backend = test_backend();
        let home = backend.fs_list(LOCAL, None).await.expect("home").path;
        let path = join_remote(&home, "mast_read_cap_test.bin");
        backend.fs_write(LOCAL, path.clone(), vec![7u8; 64]).await.expect("write");

        let stat = backend.fs_stat(LOCAL, path.clone()).await.expect("stat");
        assert!(!stat.is_dir);
        assert_eq!(stat.size, 64);
        assert!(stat.modified.is_some());
        assert!(backend.fs_stat(LOCAL, home).await.expect("stat dir").is_dir);

        let err = backend.fs_read(LOCAL, path.clone(), 16).await.expect_err("over the cap");
        assert!(matches!(err, Error::TooLarge { size: 64, max: 16, .. }));
        assert!(err.to_string().starts_with("too large:"), "matchable prefix: {err}");
        assert_eq!(backend.fs_read(LOCAL, path.clone(), 64).await.expect("under the cap"), vec![7u8; 64]);

        // The read itself is bounded, not just preflighted: even when the stat
        // gate is bypassed, at most cap + 1 detection byte come off the wire.
        let sftp = backend.transfer_sftp(LOCAL).await.expect("session");
        let bounded = read_capped(&sftp, path.clone(), 16).await.expect("capped read");
        assert_eq!(bounded.len(), 17, "streaming stops at the cap, never buffering the rest");

        cleanup(&backend, &path).await;
    }

    /// Live: fs_create_file is atomic create-if-absent — a fresh path lands as
    /// an empty file, an existing path fails without touching its contents.
    #[tokio::test]
    #[ignore]
    async fn fs_create_file_never_truncates_existing_content() {
        let backend = test_backend();
        let home = backend.fs_list(LOCAL, None).await.expect("home").path;
        let path = join_remote(&home, "mast_create_excl_test.txt");
        cleanup(&backend, &path).await;

        backend.fs_create_file(LOCAL, path.clone()).await.expect("create new");
        assert_eq!(backend.fs_read(LOCAL, path.clone(), 64).await.expect("read"), Vec::<u8>::new());

        backend.fs_write(LOCAL, path.clone(), b"precious".to_vec()).await.expect("write");
        assert!(backend.fs_create_file(LOCAL, path.clone()).await.is_err(), "an existing path refuses");
        assert_eq!(backend.fs_read(LOCAL, path.clone(), 64).await.expect("read back"), b"precious");
        assert_eq!(backend.sftp_opens.load(Ordering::Relaxed), 1, "a Status refusal does not evict");

        cleanup(&backend, &path).await;
    }

    /// Live: fs_write_checked applies a save only while the file still holds
    /// the expected bytes — a concurrent rewrite (even to a longer file) is a
    /// conflict that leaves the disk content untouched.
    #[tokio::test]
    #[ignore]
    async fn fs_write_checked_refuses_a_stale_baseline() {
        let backend = test_backend();
        let home = backend.fs_list(LOCAL, None).await.expect("home").path;
        let path = join_remote(&home, "mast_write_checked_test.txt");
        backend.fs_write(LOCAL, path.clone(), b"old".to_vec()).await.expect("seed");

        let saved = backend
            .fs_write_checked(LOCAL, path.clone(), b"old".to_vec(), b"mine".to_vec())
            .await
            .expect("matching baseline saves");
        assert_eq!(saved, WriteOutcome::Saved);
        assert_eq!(backend.fs_read(LOCAL, path.clone(), 64).await.expect("read"), b"mine");

        backend.fs_write(LOCAL, path.clone(), b"agent version".to_vec()).await.expect("agent");
        let conflict = backend
            .fs_write_checked(LOCAL, path.clone(), b"mine".to_vec(), b"clobber".to_vec())
            .await
            .expect("stale baseline conflicts");
        assert_eq!(conflict, WriteOutcome::Conflict);
        assert_eq!(
            backend.fs_read(LOCAL, path.clone(), 64).await.expect("read back"),
            b"agent version",
            "a conflict never touches the file"
        );

        cleanup(&backend, &path).await;
    }

    /// Live: two checked saves racing from the same baseline serialize on the
    /// remote lock — exactly one lands, the other reports a conflict, and the
    /// file holds the winner's bytes with no temp droppings left behind.
    #[tokio::test]
    #[ignore]
    async fn concurrent_checked_saves_admit_exactly_one_winner() {
        let backend = test_backend();
        let home = backend.fs_list(LOCAL, None).await.expect("home").path;
        let path = join_remote(&home, "mast_write_checked_race_test.txt");
        backend.fs_write(LOCAL, path.clone(), b"base".to_vec()).await.expect("seed");

        let (a, b) = tokio::join!(
            backend.fs_write_checked(LOCAL, path.clone(), b"base".to_vec(), b"aaa".to_vec()),
            backend.fs_write_checked(LOCAL, path.clone(), b"base".to_vec(), b"bbb".to_vec()),
        );
        let outcomes = [a.expect("save a"), b.expect("save b")];
        assert_eq!(
            outcomes.iter().filter(|o| **o == WriteOutcome::Saved).count(),
            1,
            "exactly one racing save wins: {outcomes:?}"
        );

        let disk = backend.fs_read(LOCAL, path.clone(), 64).await.expect("read back");
        let winner = if outcomes[0] == WriteOutcome::Saved { b"aaa" } else { b"bbb" };
        assert_eq!(disk, winner, "the file holds the winner's bytes, untorn");

        let (code, _) = backend
            .exec_capture(
                LOCAL,
                &format!("ls {}/.mast_write_checked_race_test.txt.mast-save-* 2>/dev/null", shell_single_quote(&home)),
            )
            .await
            .expect("ls temps");
        assert_ne!(code, 0, "no save temp files survive the race");

        cleanup(&backend, &path).await;
    }

    /// Live: a dead pooled session under a mutation is healed by the read-only
    /// probe (evict + redial), so the save still lands — without ever running
    /// the mutation twice.
    #[tokio::test]
    #[ignore]
    async fn dropped_session_heals_before_a_mutation() {
        let backend = test_backend();
        let home = backend.fs_list(LOCAL, None).await.expect("home").path;
        let session = backend.containers.lock().await.get(LOCAL).cloned().expect("pooled session");
        session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "test kill", "")
            .await
            .ok();
        let path = join_remote(&home, "mast_mutation_heal_test.txt");
        backend.fs_write(LOCAL, path.clone(), b"healed".to_vec()).await.expect("write after kill");
        assert_eq!(backend.fs_read(LOCAL, path.clone(), 1024).await.expect("read back"), b"healed");
        assert_eq!(backend.sftp_opens.load(Ordering::Relaxed), 2);
        cleanup(&backend, &path).await;
    }

    /// Live: a mutation's op runs exactly once — a transport-shaped failure is
    /// never replayed (the server may already have applied it) — and burns the
    /// pooled session so the next call redials. A Status failure (mkdir on an
    /// existing path) is the server answering and does not evict.
    #[tokio::test]
    #[ignore]
    async fn mutations_never_replay_and_evict_on_transport_failure() {
        let backend = test_backend();
        let home = backend.fs_list(LOCAL, None).await.expect("home").path;

        assert!(backend.fs_mkdir(LOCAL, home).await.is_err(), "mkdir on an existing path fails");
        assert_eq!(backend.sftp_opens.load(Ordering::Relaxed), 1, "a Status error does not evict");

        let calls = AtomicU64::new(0);
        let outcome = backend
            .mutate_sftp(LOCAL, |_| async {
                calls.fetch_add(1, Ordering::Relaxed);
                Err::<(), SftpError>(
                    std::io::Error::new(std::io::ErrorKind::ConnectionReset, "mid-request drop").into(),
                )
            })
            .await;
        assert!(outcome.is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 1, "mutations are never replayed");
        assert!(
            backend.sftp_pool.lock().await.get(LOCAL).is_none(),
            "a transport failure evicts the session"
        );
        backend.fs_list(LOCAL, None).await.expect("next call redials");
        assert_eq!(backend.sftp_opens.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn validate_stream_path_allows_the_two_routes_and_blocks_injection() {
        assert!(validate_stream_path("/v1/events/stream").is_ok());
        assert!(validate_stream_path("/v1/events/stream?project=demo&type=board_updated").is_ok());
        assert!(
            validate_stream_path("/v1/runs/0197a2c4-demo-run-id/stream?since=5").is_ok()
        );
        // The retired project-scoped agent stream is off the allowlist.
        assert!(validate_stream_path("/v1/projects/demo/agent/stream?role=build").is_err());
        // CRLF injection into the request target is rejected (control bytes).
        assert!(validate_stream_path("/v1/events/stream HTTP/1.1\r\nX-Injected: 1").is_err());
        // A bare space in the target is rejected.
        assert!(validate_stream_path("/v1/events/stream x").is_err());
        // Off-allowlist routes are rejected even when byte-clean.
        assert!(validate_stream_path("/v1/specs").is_err());
        assert!(validate_stream_path("relative/path").is_err());
    }
}
