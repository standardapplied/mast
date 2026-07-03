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
use std::sync::Arc;

use async_trait::async_trait;
use russh::client::{self, Config, Handle, Handler, Msg};
use russh::keys::key;
use russh::keys::load_secret_key;
use russh::{Channel, ChannelMsg};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no ~/.sail/config.yaml — run `sail host config` or log in first")]
    NoConfig,
    #[error("config is missing `{0}`")]
    MissingField(&'static str),
    #[error("no usable SSH key in ~/.ssh (tried id_ed25519, id_ecdsa, id_rsa)")]
    NoKey,
    #[error("publickey auth rejected for {0}")]
    AuthRejected(String),
    #[error("malformed HTTP response from the control plane")]
    BadResponse,
    #[error("no terminal with id {0}")]
    NoTerminal(String),
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
/// the SSH hop to the devbox and the loopback address the control plane listens
/// on there.
#[derive(Clone, Debug)]
pub struct SailConfig {
    pub ssh_host: String,
    pub ssh_user: String,
    pub ssh_port: u16,
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
        let ssh_user = map
            .get("user")
            .cloned()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_else(|| "root".into());
        let server = map
            .get("server")
            .cloned()
            .unwrap_or_else(|| "http://127.0.0.1:7070".into());
        let (server_host, server_port) = parse_server(&server);

        Ok(SailConfig {
            ssh_host,
            ssh_user,
            ssh_port: 22,
            server_host,
            server_port,
            token: map.get("token").cloned().filter(|t| !t.trim().is_empty()),
            key_path: map.get("key").cloned(),
        })
    }
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
    session: Mutex<Option<Handle<Client>>>,
    terminals: Mutex<HashMap<String, mpsc::Sender<TermCmd>>>,
}

#[derive(Serialize)]
pub struct SailResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub body: String,
}

impl Backend {
    pub fn new() -> Result<Self, Error> {
        Ok(Backend {
            config: SailConfig::load()?,
            session: Mutex::new(None),
            terminals: Mutex::new(HashMap::new()),
        })
    }

    pub fn describe(&self) -> &SailConfig {
        &self.config
    }

    pub fn connected(&self) -> bool {
        self.session
            .try_lock()
            .map(|g| g.is_some())
            .unwrap_or(true)
    }

    async fn dial(&self) -> Result<Handle<Client>, Error> {
        let identity = load_identity(self.config.key_path.as_deref())?;
        let mut handle = client::connect(
            Arc::new(Config::default()),
            (self.config.ssh_host.as_str(), self.config.ssh_port),
            Client,
        )
        .await?;
        let ok = handle
            .authenticate_publickey(&self.config.ssh_user, Arc::new(identity))
            .await?;
        if !ok {
            return Err(Error::AuthRejected(self.config.ssh_user.clone()));
        }
        Ok(handle)
    }

    /// Connects the session if it isn't already up. A dead session is cleared
    /// by `open_*` so the next call redials (devbox reboot, laptop sleep).
    async fn ensure(&self) -> Result<(), Error> {
        let mut guard = self.session.lock().await;
        if guard.is_none() {
            *guard = Some(self.dial().await?);
        }
        Ok(())
    }

    async fn open_session_channel(&self) -> Result<Channel<Msg>, Error> {
        self.ensure().await?;
        let mut guard = self.session.lock().await;
        let result = guard.as_ref().expect("ensured").channel_open_session().await;
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
            .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
            .await;
        if result.is_err() {
            *guard = None;
        }
        Ok(result?)
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

        stream.write_all(req.as_bytes()).await?;
        stream.flush().await?;

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await?;
        parse_http(&raw)
    }

    pub async fn terminal_open(
        &self,
        app: AppHandle,
        id: String,
        cols: u32,
        rows: u32,
    ) -> Result<(), Error> {
        let mut channel = self.open_session_channel().await?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;

        let (tx, mut rx) = mpsc::channel::<TermCmd>(256);
        self.terminals.lock().await.insert(id.clone(), tx);

        let data_event = format!("terminal://data/{id}");
        let exit_event = format!("terminal://exit/{id}");

        tokio::spawn(async move {
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

fn load_identity(explicit: Option<&str>) -> Result<key::KeyPair, Error> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(path) = explicit {
        candidates.push(path.into());
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
