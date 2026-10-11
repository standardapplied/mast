//! Tauri entry point. The React webview talks to this Rust core over `invoke`; the core owns the SSH session that
//! reaches the control plane and the container terminals. One `run()` serves
//! desktop (main.rs) and mobile (the `mobile_entry_point`).

mod login;
mod pairing;
mod pty;
#[cfg(test)]
mod pty_probe;
mod session_frames;
mod ssh;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;
use ssh::Backend;
use tauri::http::HeaderMap;
use tauri::ipc::{Channel, CommandArg, CommandItem, InvokeBody, InvokeError, InvokeResponseBody, Request};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{Mutex, MutexGuard};

/// Lazily-built backend. Construction reads the settings on disk (`~/.sail/mast.yaml`, else
/// the CLI's `~/.sail/config.yaml`); if neither is there the app still renders and the status
/// read says why instead of panicking at startup. The slot is replaceable: pairing installs a
/// backend built from a connect code, forgetting the box empties it. Held behind an `Arc` so
/// the passkey ceremony can hand a clone to its background port-forward task.
#[derive(Default)]
struct AppState {
    backend: Mutex<Option<Arc<Backend>>>,
    /// Held across a change of box (see [`AppState::change`]).
    changing: Mutex<()>,
    /// Whether this run of the app forgot a box: the first-run screen then says the pairing is
    /// still on the box. Pairing again takes it back.
    forgotten: AtomicBool,
}

impl AppState {
    /// The backend the settings on disk name, built on first use. Only the status read asks
    /// this way; every other command names the backend it is for (see [`Bound`]).
    async fn backend(&self) -> Result<Arc<Backend>, ssh::Error> {
        let mut slot = self.backend.lock().await;
        if let Some(backend) = slot.as_ref() {
            return Ok(backend.clone());
        }
        let settings = ssh::ConnectionSettings::load(&ssh::local_home()?)?;
        let backend = Arc::new(Backend::new(settings));
        *slot = Some(backend.clone());
        Ok(backend)
    }

    /// The backend a command was sent for, or a refusal: never the one that took its place,
    /// and never one built to answer it.
    async fn backend_for(&self, page: Option<u64>) -> Result<Arc<Backend>, ssh::Error> {
        let named = page.ok_or(ssh::Error::NoBox)?;
        match self.backend.lock().await.as_ref() {
            Some(backend) if backend.generation() == named => Ok(backend.clone()),
            _ => Err(ssh::Error::BoxChanged),
        }
    }

    /// The connection as the webview reads it, and whether this run forgot a box.
    async fn status(&self, loaded: Result<Arc<Backend>, ssh::Error>) -> serde_json::Value {
        let mut status = ssh::connection_status(loaded).await;
        status["forgotten"] = json!(self.forgotten.load(Ordering::Relaxed));
        status
    }

    /// Admits one change of box at a time (pairing, forgetting), and only from the page whose
    /// backend is still the app's, or from a page with none while the app has none. A Connect
    /// and a Forget asked of one page happen in turn, and once the first has changed the box
    /// the second is refused: it neither forgets the box the first one paired nor pairs over
    /// what the first one forgot. After a first that failed, the second runs.
    async fn change(&self, page: Option<u64>) -> Result<MutexGuard<'_, ()>, ssh::Error> {
        let alone = self.changing.lock().await;
        let held = self.backend.lock().await.as_ref().map(|backend| backend.generation());
        if held == page {
            Ok(alone)
        } else {
            Err(ssh::Error::BoxChanged)
        }
    }

    /// Connects with a pasted code. Nothing is written until the box has answered `whoami`;
    /// then the settings land in `~/.sail/mast.yaml` and the backend that proved them becomes
    /// the app's.
    async fn pair(&self, page: Option<u64>, home: &Path, code: &str) -> Result<(), ssh::Error> {
        let _alone = self.change(page).await?;
        let backend = pairing::pair(home, code).await?;
        self.replace(Some(Arc::new(backend))).await;
        self.forgotten.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// Forgets the paired box on this Mac: `mast.yaml` and the key file go, and the next status
    /// read starts from whatever settings remain. The pairing on the box is untouched.
    async fn forget(&self, page: Option<u64>, home: &Path) -> Result<(), ssh::Error> {
        let _alone = self.change(page).await?;
        pairing::forget(home)?;
        self.replace(None).await;
        self.forgotten.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Swaps the backend, and the one it replaces lets go of its terminals and streams and takes
    /// no more: nothing the webview does afterwards can reach them.
    async fn replace(&self, backend: Option<Arc<Backend>>) {
        let retired = std::mem::replace(&mut *self.backend.lock().await, backend);
        if let Some(retired) = retired {
            retired.retire().await;
        }
    }
}

/// The header on which a command names the backend it is for.
const BACKEND_HEADER: &str = "x-mast-backend";

/// A command's claim on the backend it was sent for. A page of the webview is for one backend,
/// the first its status named, and says so on every command; the command is served from that
/// backend or refused. Whatever a page began on one box (a kill waiting on a lookup, a save, a
/// close, a Connect, a Forget) therefore cannot land on the box that replaced it, however late
/// it arrives. Only the status read, which is how a page learns its backend, takes the app's
/// state unbound.
struct Bound<'r> {
    state: State<'r, AppState>,
    page: Option<u64>,
}

impl Bound<'_> {
    async fn backend(&self) -> Result<Arc<Backend>, ssh::Error> {
        self.state.backend_for(self.page).await
    }
}

impl<'r, 'de: 'r, R: Runtime> CommandArg<'de, R> for Bound<'r> {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let page = named_backend(command.message.headers());
        Ok(Bound { state: State::from_command(command)?, page })
    }
}

fn named_backend(headers: &HeaderMap) -> Option<u64> {
    headers.get(BACKEND_HEADER)?.to_str().ok()?.parse().ok()
}

#[tauri::command]
async fn sail_request(
    state: Bound<'_>,
    method: String,
    path: String,
    body: Option<String>,
    if_match: Option<String>,
) -> Result<ssh::SailResponse, String> {
    let backend = state.backend().await?;
    backend
        .webview_request(&method, &path, body, if_match)
        .await
        .map_err(String::from)
}

#[tauri::command]
async fn connection_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.status(state.backend().await).await)
}

/// What a pasted connect code names (who, which box), or the one sentence saying why it is not
/// a usable code. Parsed here so the webview never handles the key or the token as fields.
#[tauri::command]
fn connect_code_preview(code: String) -> Result<pairing::CodePreview, String> {
    Ok(pairing::ConnectCode::parse(&code)?.preview())
}

/// Connect with a pasted code, for the page that asked (see [`AppState::pair`]).
#[tauri::command]
async fn pair(state: Bound<'_>, code: String) -> Result<(), String> {
    state.state.pair(state.page, &ssh::local_home()?, &code).await.map_err(String::from)
}

/// Forget the paired box on this Mac, for the page that asked (see [`AppState::forget`]).
#[tauri::command]
async fn forget_box(state: Bound<'_>) -> Result<(), String> {
    state.state.forget(state.page, &ssh::local_home()?).await.map_err(String::from)
}

/// Run the passkey sign-in ceremony (system browser → Touch ID → loopback
/// callback) and persist the resulting session token.
#[tauri::command]
async fn login(app: AppHandle, state: Bound<'_>) -> Result<(), String> {
    let backend = state.backend().await?;
    login::run(backend, app).await.map_err(String::from)
}

/// Clear the API/session token from config and memory; the next request will be
/// unauthenticated until the user signs in again.
#[tauri::command]
async fn logout(state: Bound<'_>) -> Result<(), String> {
    state.backend().await?.set_token(None).await.map_err(String::from)
}

/// Open a URL in the Mac's default browser: the updater's release page, a markdown link, or a
/// link a program printed in a terminal. That last source is untrusted bytes, so only the schemes a
/// browser is for get through; a `file:` path (which names the box, not the Mac), `javascript:`
/// or a custom scheme is refused by name.
#[tauri::command]
async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    admit_url(&url)?;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

const OPENABLE_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// The scheme allowlist for `open_url`, by RFC 3986's scheme grammar (case-insensitive).
fn admit_url(url: &str) -> Result<(), String> {
    let scheme = url_scheme(url).ok_or_else(|| "links without a scheme are not opened".to_string())?;
    if OPENABLE_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
        Ok(())
    } else {
        Err(format!("{scheme}: links are not opened by Mast"))
    }
}

fn url_scheme(url: &str) -> Option<&str> {
    let (scheme, _) = url.split_once(':')?;
    let mut chars = scheme.chars();
    let first = chars.next()?;
    let valid = first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid.then_some(scheme)
}

#[tauri::command]
async fn list_targets(state: Bound<'_>) -> Result<Vec<String>, String> {
    state.backend().await?.list_targets().await.map_err(String::from)
}

#[tauri::command]
async fn fs_list(
    state: Bound<'_>,
    target: String,
    path: Option<String>,
) -> Result<ssh::FsListing, String> {
    state.backend().await?.fs_list(&target, path).await.map_err(String::from)
}

/// One invoke for a bounded subtree (defaults: depth 3, 2000 entries), so a
/// first-time tree expand doesn't pay one round-trip per directory. `after`
/// resumes a paged root listing where the previous response's `nextCursor`
/// left off.
#[tauri::command]
async fn fs_list_deep(
    state: Bound<'_>,
    target: String,
    path: Option<String>,
    depth: Option<u32>,
    max_entries: Option<usize>,
    after: Option<ssh::PageCursor>,
) -> Result<ssh::DeepListing, String> {
    state
        .backend()
        .await?
        .fs_list_deep(
            &target,
            path,
            depth.unwrap_or(ssh::DEEP_LIST_DEPTH),
            max_entries.unwrap_or(ssh::DEEP_LIST_MAX_ENTRIES),
            after,
        )
        .await
        .map_err(String::from)
}

#[tauri::command]
async fn fs_stat(state: Bound<'_>, target: String, path: String) -> Result<ssh::FsStat, String> {
    state.backend().await?.fs_stat(&target, path).await.map_err(String::from)
}

#[tauri::command]
async fn fs_read(
    state: Bound<'_>,
    target: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, String> {
    state
        .backend()
        .await?
        .fs_read(&target, path, max_bytes.unwrap_or(ssh::DEFAULT_READ_CAP))
        .await
        .map_err(String::from)
}

#[tauri::command]
async fn fs_upload(
    app: AppHandle,
    state: Bound<'_>,
    target: String,
    remote_dir: String,
    local_paths: Vec<String>,
    transfer_id: String,
) -> Result<Vec<String>, String> {
    state
        .backend()
        .await?
        .fs_upload(&app, &target, remote_dir, local_paths, transfer_id)
        .await
        .map_err(String::from)
}

#[tauri::command]
async fn fs_download(
    app: AppHandle,
    state: Bound<'_>,
    target: String,
    remote_paths: Vec<String>,
    local_dir: Option<String>,
    transfer_id: String,
) -> Result<Vec<String>, String> {
    state
        .backend()
        .await?
        .fs_download(&app, &target, remote_paths, local_dir, transfer_id)
        .await
        .map_err(String::from)
}

/// Create an empty file atomically (CREATE|EXCLUDE) — fails on an existing
/// path instead of truncating it.
#[tauri::command]
async fn fs_create_file(
    state: Bound<'_>,
    target: String,
    path: String,
) -> Result<(), String> {
    state.backend().await?.fs_create_file(&target, path).await.map_err(String::from)
}

#[tauri::command]
async fn fs_write(
    state: Bound<'_>,
    target: String,
    path: String,
    contents: Vec<u8>,
) -> Result<(), String> {
    state.backend().await?.fs_write(&target, path, contents).await.map_err(String::from)
}

/// Editor save with the conflict guard server-side: overwrite only while the
/// file still holds `expected`, in one backend operation.
#[tauri::command]
async fn fs_write_checked(
    state: Bound<'_>,
    target: String,
    path: String,
    expected: Vec<u8>,
    contents: Vec<u8>,
) -> Result<ssh::WriteOutcome, String> {
    state
        .backend()
        .await?
        .fs_write_checked(&target, path, expected, contents)
        .await
        .map_err(String::from)
}

#[tauri::command]
async fn fs_rename(state: Bound<'_>, target: String, from: String, to: String) -> Result<(), String> {
    state.backend().await?.fs_rename(&target, from, to).await.map_err(String::from)
}

#[tauri::command]
async fn fs_mkdir(state: Bound<'_>, target: String, path: String) -> Result<(), String> {
    state.backend().await?.fs_mkdir(&target, path).await.map_err(String::from)
}

#[tauri::command]
async fn fs_delete(
    app: AppHandle,
    state: Bound<'_>,
    target: String,
    path: String,
    transfer_id: String,
) -> Result<(), String> {
    state.backend().await?.fs_delete(&app, &target, path, transfer_id).await.map_err(String::from)
}

/// Download a file to ~/Downloads and open it in the OS default app.
#[tauri::command]
async fn fs_open(
    app: AppHandle,
    state: Bound<'_>,
    target: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let landed = state
        .backend()
        .await?
        .fs_download(&app, &target, vec![remote_path], None, transfer_id)
        .await
        .map_err(String::from)?;
    if let Some(local) = landed.first() {
        app.opener()
            .open_path(local.clone(), None::<&str>)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A webview-side failure (an uncaught error, a rejected promise, a render crash) written to the
/// process's stderr — the one channel a release build exposes, since its webview has no inspector.
#[tauri::command]
fn log_error(message: String) {
    eprintln!("mast webview: {message}");
}

/// Read the system clipboard as text. The webview cannot do this itself: WKWebView never fires DOM
/// paste events on a non-editable surface, and its async clipboard *read* is gesture-gated — while
/// `pbpaste` ships on every Mac. Empty clipboard reads as an empty string, not an error.
#[tauri::command]
async fn clipboard_read_text() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let out = tokio::task::spawn_blocking(|| pbpaste_command().output())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("pbpaste: {e}"))?;
        if !out.status.success() {
            return Err(format!("pbpaste exited with {}", out.status));
        }
        clipboard_text(out.stdout).map_err(|e| {
            eprintln!("mast clipboard: {e}");
            e
        })
    }
    #[cfg(not(target_os = "macos"))]
    Err("clipboard read is only supported on macOS".into())
}

/// `pbpaste` pinned to a UTF-8 locale. A Finder-launched app has no `LANG`, and in the C locale
/// pbpaste writes the legacy 8-bit encoding (MacRoman), which turned every é and curly quote
/// into one U+FFFD downstream. The app's own environment is never trusted for text encoding.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pbpaste_command() -> std::process::Command {
    let mut cmd = std::process::Command::new("pbpaste");
    cmd.env("LC_ALL", "en_US.UTF-8").env("LANG", "en_US.UTF-8");
    cmd
}

/// Strict decode: a byte sequence that is not UTF-8 is a failed paste, never a lossy one —
/// silently corrupting what the user feeds an agent is worse than pasting nothing.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clipboard_text(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| "clipboard text is not UTF-8".to_string())
}

/// A bell you can hear when you are not looking: the user's own alert sound at their alert volume
/// (`NSBeep`, honouring mute), a Dock bounce, and the Dock badge (`None` clears it). The webview
/// decides — focus, setting, mute, coalescing — and this only acts, so it runs on the main thread
/// where AppKit expects to be spoken to.
#[tauri::command]
fn attention(window: tauri::WebviewWindow, sound: bool, bounce: bool, badge: Option<i64>) -> Result<(), String> {
    let badge = badge_count(badge)?;
    #[cfg(target_os = "macos")]
    {
        if sound {
            // SAFETY: NSBeep takes no arguments and touches no memory of ours.
            unsafe { NSBeep() };
        }
        if bounce {
            window
                .request_user_attention(Some(tauri::UserAttentionType::Informational))
                .map_err(|e| e.to_string())?;
        }
        window.set_badge_count(badge).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, sound, bounce, badge);
        Err("attention is only supported on macOS".into())
    }
}

#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
extern "C" {
    fn NSBeep();
}

/// The badge as the Dock wants it: the count of unseen bells, none at zero, never negative.
fn badge_count(badge: Option<i64>) -> Result<Option<i64>, String> {
    match badge {
        Some(n) if n < 0 => Err(format!("badge count {n} is negative")),
        Some(0) | None => Ok(None),
        Some(n) => Ok(Some(n)),
    }
}

/// Parameters for creating a fresh host-owned session before attaching to it.
#[derive(serde::Deserialize)]
struct SessionCreate {
    command: Vec<String>,
    cwd: String,
    project: String,
    #[serde(default)]
    room: String,
    cols: u32,
    rows: u32,
}

/// How `session_open` fails: the same `{class, reason}` shape as the ending frame on the session
/// channel, so the pane reads a failure before the attach exactly like one after it.
#[derive(serde::Serialize)]
struct SessionEnd {
    class: &'static str,
    reason: String,
}

impl From<ssh::Error> for SessionEnd {
    fn from(e: ssh::Error) -> Self {
        match &e {
            ssh::Error::Io(io) => SessionEnd { class: ssh::end_class(io), reason: ssh::end_reason(io) },
            _ => SessionEnd { class: "transport", reason: e.to_string() },
        }
    }
}

impl From<String> for SessionEnd {
    fn from(reason: String) -> Self {
        SessionEnd { class: "transport", reason }
    }
}

/// Attach a terminal to a host-owned pty session over SSH direct-streamlocal. Resolves once the
/// host has acknowledged the (optional) Create and the Attach; a failure before that is the
/// rejection, as `{class, reason}`. Everything after — output, replay markers, terminal-state
/// changes, the ending — arrives as raw frames on `on_data`, in order (see `session_frames`). A
/// `create` mints the session first (durable, survives the app).
#[tauri::command]
async fn session_open(
    state: Bound<'_>,
    id: String,
    socket_path: String,
    token: String,
    session: String,
    write: bool,
    create: Option<SessionCreate>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), SessionEnd> {
    let req = pty::AttachRequest {
        token,
        session,
        write,
        create: create.map(|c| pty::CreateSpec {
            command: c.command,
            cwd: c.cwd,
            project: c.project,
            room: c.room,
            cols: c.cols,
            rows: c.rows,
        }),
    };
    state
        .backend()
        .await?
        .session_open(id, socket_path, req, on_data)
        .await
        .map_err(SessionEnd::from)
}

/// The header naming the attachment a raw `session_write` body is for.
const SESSION_HEADER: &str = "x-mast-session";

/// Keystrokes and pastes toward a session. The body is the raw bytes (no JSON number array per
/// byte); the attachment id rides the `x-mast-session` header.
#[tauri::command]
async fn session_write(state: Bound<'_>, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("session_write: missing {SESSION_HEADER} header"))?
        .to_owned();
    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("session_write: the body must be raw bytes".into()),
    };
    state.backend().await?.session_write(&id, data).await.map_err(String::from)
}

#[tauri::command]
async fn session_resize(
    state: Bound<'_>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    state.backend().await?.session_resize(&id, cols, rows).await.map_err(String::from)
}

#[tauri::command]
async fn session_close(state: Bound<'_>, id: String) -> Result<(), String> {
    state.backend().await?.session_close(&id).await.map_err(String::from)
}

/// Claim the write token on an attached session; the grant arrives for every
/// subscriber as a `writer_changed` meta event, never as a direct reply.
#[tauri::command]
async fn session_take_write(state: Bound<'_>, id: String) -> Result<(), String> {
    state.backend().await?.session_take_write(&id).await.map_err(String::from)
}

/// List the host's sessions (name, incarnation id, liveness, attached count, current writer,
/// room, command) under the host boot id that answered, draining every page of the
/// cursor-paginated listing.
#[tauri::command]
async fn session_list(
    state: Bound<'_>,
    socket_path: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let list = state
        .backend()
        .await?
        .session_list(socket_path, token)
        .await
        .map_err(String::from)?;
    let sessions = list
        .sessions
        .into_iter()
        .map(|s| json!({
            "name": s.name,
            "instanceId": s.instance_id,
            "live": s.live,
            "attached": s.attached,
            "writerFde": s.writer_fde,
            "room": s.room,
            "command": s.command,
        }))
        .collect::<Vec<_>>();
    Ok(json!({ "hostBootId": list.host_boot_id, "sessions": sessions }))
}

/// Create a host-owned session without attaching (a durable named shell).
#[tauri::command]
async fn session_new(
    state: Bound<'_>,
    socket_path: String,
    token: String,
    create: SessionCreate,
    session: String,
) -> Result<(), String> {
    let request = pty::Frame::Create {
        session,
        command: create.command,
        cwd: create.cwd,
        project: create.project,
        room: create.room,
        cols: create.cols,
        rows: create.rows,
    };
    expect_ok(
        state
            .backend()
            .await?
            .session_control(socket_path, token, request)
            .await
            .map_err(String::from),
    )
}

/// End a host-owned session and its process.
#[tauri::command]
async fn session_kill(
    state: Bound<'_>,
    socket_path: String,
    token: String,
    session: String,
) -> Result<(), String> {
    let reply = state
        .backend()
        .await?
        .session_kill(socket_path, token, session)
        .await
        .map_err(String::from);
    expect_ok(reply)
}

/// Collapses a control reply into unit-or-error: Ok passes, Err surfaces the host's message.
fn expect_ok(reply: Result<pty::Frame, String>) -> Result<(), String> {
    match reply? {
        pty::Frame::Ok => Ok(()),
        pty::Frame::Err(message) => Err(message),
        other => Err(format!("unexpected control reply: {other:?}")),
    }
}

/// Open a long-lived SSE tail to the control plane (events or agent log) and
/// stream its body to the webview as `stream://{open,data,end}/{id}`.
#[tauri::command]
async fn stream_open(
    app: AppHandle,
    state: Bound<'_>,
    id: String,
    path: String,
) -> Result<(), String> {
    state.backend().await?.stream_open(app, id, path).await.map_err(String::from)
}

#[tauri::command]
async fn stream_close(state: Bound<'_>, id: String) -> Result<(), String> {
    state.backend().await?.stream_close(&id).await.map_err(String::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Auto-update + relaunch are desktop-only (the app self-updates from
            // the signed GitHub release; mobile updates ship through the store).
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            sail_request,
            connection_status,
            connect_code_preview,
            pair,
            forget_box,
            login,
            logout,
            open_url,
            list_targets,
            fs_list,
            fs_list_deep,
            fs_stat,
            fs_read,
            fs_upload,
            fs_download,
            fs_create_file,
            fs_write,
            fs_write_checked,
            fs_rename,
            fs_mkdir,
            fs_delete,
            fs_open,
            clipboard_read_text,
            attention,
            log_error,
            session_open,
            session_write,
            session_resize,
            session_close,
            session_take_write,
            session_list,
            session_new,
            session_kill,
            stream_open,
            stream_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mast");
}

#[cfg(test)]
mod bound_command_tests {
    use super::*;

    fn backend_to(alias: &str) -> Arc<Backend> {
        Arc::new(Backend::new(ssh::ConnectionSettings {
            home: std::env::temp_dir(),
            route: ssh::Route::SshConfig { alias: alias.into(), fallback_user: None, key_path: None },
            server_host: "127.0.0.1".into(),
            server_port: 7070,
            token: None,
        }))
    }

    fn naming(generation: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(BACKEND_HEADER, generation.parse().unwrap());
        headers
    }

    /// A kill sent for one box while it was being forgotten: by the time it is served the app
    /// holds the next box, and the kill must not reach a session of the same name there.
    #[tokio::test]
    async fn a_command_is_served_by_the_backend_it_names_and_refused_by_the_one_that_replaced_it() {
        let (first, second) = (backend_to("first"), backend_to("second"));
        let state = AppState::default();
        state.replace(Some(first.clone())).await;
        let for_first = named_backend(&naming(&first.generation().to_string()));
        assert!(Arc::ptr_eq(&state.backend_for(for_first).await.ok().unwrap(), &first));

        state.replace(Some(second.clone())).await;

        assert!(matches!(state.backend_for(for_first).await, Err(ssh::Error::BoxChanged)));
        let for_second = named_backend(&naming(&second.generation().to_string()));
        assert!(Arc::ptr_eq(&state.backend_for(for_second).await.ok().unwrap(), &second));
    }

    #[tokio::test]
    async fn a_command_that_names_no_backend_or_a_forgotten_one_is_refused_and_builds_none() {
        let state = AppState::default();
        let first = backend_to("first");
        state.replace(Some(first.clone())).await;
        assert!(matches!(state.backend_for(named_backend(&HeaderMap::new())).await, Err(ssh::Error::NoBox)));
        assert!(matches!(state.backend_for(named_backend(&naming("not a number"))).await, Err(ssh::Error::NoBox)));

        state.replace(None).await;

        assert!(matches!(state.backend_for(Some(first.generation())).await, Err(ssh::Error::BoxChanged)));
        assert!(matches!(state.backend_for(None).await, Err(ssh::Error::NoBox)));
        assert!(state.backend.lock().await.is_none());
    }

    /// A command that took the app's state unbound would be served by whichever backend is
    /// there when it arrives. The status read is how a page learns its backend, so it alone
    /// may. This reads the source for the one spelling every command here uses, so it catches a
    /// command added the old way, not one that reaches the state by another route.
    #[test]
    fn only_the_status_read_is_declared_with_the_app_state_unbound() {
        let unbound = concat!("State<'_, ", "AppState>");
        let source = include_str!("lib.rs");
        assert_eq!(source.matches(unbound).count(), 1);
        assert!(source.contains(&format!("async fn connection_status(state: {unbound})")));
    }
}

#[cfg(test)]
mod open_url_tests {
    use super::*;

    #[test]
    fn browser_schemes_are_admitted_whatever_their_case() {
        for url in [
            "https://github.com/standardapplied/mast/pull/1",
            "http://localhost:8080/?q=1#f",
            "HTTPS://Example.COM",
            "mailto:uday@standardapplied.com",
            "https://x.y/path?next=javascript:alert(1)",
        ] {
            assert_eq!(admit_url(url), Ok(()), "{url}");
        }
    }

    #[test]
    fn everything_else_is_refused_by_scheme_name() {
        for (url, scheme) in [
            ("file:///etc/passwd", "file"),
            ("FILE:///Users/uday", "FILE"),
            ("javascript:alert(1)", "javascript"),
            ("ssh://box", "ssh"),
            ("x-apple.systempreferences:com.apple.preference", "x-apple.systempreferences"),
            ("data:text/html,<script>", "data"),
        ] {
            assert_eq!(admit_url(url), Err(format!("{scheme}: links are not opened by Mast")));
        }
    }

    #[test]
    fn a_missing_or_malformed_scheme_is_refused_without_naming_one() {
        for url in ["//evil.example", "example.com", "", "1http://x", ":nothing", "ht tp://x", "http//x"] {
            assert_eq!(admit_url(url), Err("links without a scheme are not opened".to_string()), "{url}");
        }
    }
}

#[cfg(test)]
mod attention_tests {
    use super::*;

    #[test]
    fn the_badge_is_the_count_none_at_zero() {
        for (badge, expected) in [(None, None), (Some(0), None), (Some(1), Some(1)), (Some(12), Some(12))] {
            assert_eq!(badge_count(badge), Ok(expected), "{badge:?}");
        }
    }

    #[test]
    fn a_negative_badge_is_refused_by_value() {
        for n in [-1, -7] {
            assert_eq!(badge_count(Some(n)), Err(format!("badge count {n} is negative")));
        }
    }
}

#[cfg(test)]
mod clipboard_tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn pbpaste_runs_in_a_utf8_locale() {
        let cmd = pbpaste_command();
        assert_eq!(cmd.get_program(), "pbpaste");
        let env: Vec<_> = cmd.get_envs().collect();
        assert!(env.contains(&(OsStr::new("LC_ALL"), Some(OsStr::new("en_US.UTF-8")))));
        assert!(env.contains(&(OsStr::new("LANG"), Some(OsStr::new("en_US.UTF-8")))));
    }

    #[test]
    fn utf8_clipboard_decodes_byte_exact() {
        let text = "a’b “q” é\u{a0}x";
        assert_eq!(clipboard_text(text.as_bytes().to_vec()).unwrap(), text);
        assert_eq!(clipboard_text(Vec::new()).unwrap(), "");
    }

    #[test]
    fn macroman_clipboard_is_an_error_not_a_lossy_read() {
        let macroman = b"L\x8Eona \xD5 \xCA".to_vec();
        assert_eq!(clipboard_text(macroman), Err("clipboard text is not UTF-8".to_string()));
    }
}
