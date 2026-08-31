//! Tauri entry point. The React webview talks to this Rust core over `invoke`; the core owns the SSH session that
//! reaches the control plane and the container terminals. One `run()` serves
//! desktop (main.rs) and mobile (the `mobile_entry_point`).

mod login;
mod pty;
mod ssh;

use std::sync::Arc;

use serde_json::json;
use ssh::Backend;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::OnceCell;

/// Lazily-built backend. Construction reads `~/.sail/config.yaml`; if that is
/// missing the app still renders (demo/disconnected) and the first real call
/// surfaces a clear error instead of panicking at startup. Held behind an `Arc`
/// so the passkey ceremony can hand a clone to its background port-forward task.
struct AppState {
    backend: OnceCell<Arc<Backend>>,
}

impl AppState {
    async fn backend(&self) -> Result<Arc<Backend>, String> {
        self.backend
            .get_or_try_init(|| async { Backend::new().map(Arc::new).map_err(String::from) })
            .await
            .cloned()
    }
}

#[tauri::command]
async fn sail_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<String>,
    if_match: Option<String>,
) -> Result<ssh::SailResponse, String> {
    let backend = state.backend().await?;
    backend
        .sail_request(&method, &path, body, if_match)
        .await
        .map_err(String::from)
}

#[tauri::command]
async fn connection_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let backend = match state.backend().await {
        Ok(backend) => backend,
        Err(detail) => {
            return Ok(json!({
                "phase": "error",
                "server": "",
                "tokenPresent": false,
                "tokenKind": "none",
                "stream": "disconnected",
                "detail": detail,
            }))
        }
    };

    // `sess_` = passkey-login session; anything else is a long-lived API token.
    // Read the *runtime* token, not the on-disk one, so a login/logout this
    // session is reflected without a restart.
    let has_token = backend.has_token().await;
    let cfg = backend.describe();
    let mut status = json!({
        "server": format!("{}:{}", cfg.server_host, cfg.server_port),
        "sshHost": cfg.ssh_host,
        "tokenPresent": has_token,
        "tokenKind": backend.token_kind().await,
    });
    if !has_token {
        status["phase"] = json!("unauthenticated");
        status["stream"] = json!("disconnected");
        return Ok(status);
    }
    match backend.connect().await {
        Ok(()) => {
            status["phase"] = json!("ready");
            status["stream"] = json!("connected");
        }
        Err(e) => {
            status["phase"] = json!("error");
            status["stream"] = json!("disconnected");
            status["detail"] = json!(e.to_string());
        }
    }
    Ok(status)
}

/// Run the passkey sign-in ceremony (system browser → Touch ID → loopback
/// callback) and persist the resulting session token.
#[tauri::command]
async fn login(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let backend = state.backend().await?;
    login::run(backend, app).await.map_err(String::from)
}

/// Clear the API/session token from config and memory; the next request will be
/// unauthenticated until the user signs in again.
#[tauri::command]
async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    state.backend().await?.set_token(None).await.map_err(String::from)
}

/// Open a URL in the system browser (updater's "open the release page" fallback).
#[tauri::command]
async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_targets(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.backend().await?.list_targets())
}

#[tauri::command]
async fn fs_list(
    state: State<'_, AppState>,
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
    state: State<'_, AppState>,
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
async fn fs_stat(state: State<'_, AppState>, target: String, path: String) -> Result<ssh::FsStat, String> {
    state.backend().await?.fs_stat(&target, path).await.map_err(String::from)
}

#[tauri::command]
async fn fs_read(
    state: State<'_, AppState>,
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
    state: State<'_, AppState>,
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
    state: State<'_, AppState>,
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
    state: State<'_, AppState>,
    target: String,
    path: String,
) -> Result<(), String> {
    state.backend().await?.fs_create_file(&target, path).await.map_err(String::from)
}

#[tauri::command]
async fn fs_write(
    state: State<'_, AppState>,
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
    state: State<'_, AppState>,
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
async fn fs_rename(state: State<'_, AppState>, target: String, from: String, to: String) -> Result<(), String> {
    state.backend().await?.fs_rename(&target, from, to).await.map_err(String::from)
}

#[tauri::command]
async fn fs_mkdir(state: State<'_, AppState>, target: String, path: String) -> Result<(), String> {
    state.backend().await?.fs_mkdir(&target, path).await.map_err(String::from)
}

#[tauri::command]
async fn fs_delete(
    app: AppHandle,
    state: State<'_, AppState>,
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
    state: State<'_, AppState>,
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

/// Read the system clipboard as text. The webview cannot do this itself: WKWebView never fires DOM
/// paste events on a non-editable surface, and its async clipboard *read* is gesture-gated — while
/// `pbpaste` ships on every Mac. Empty clipboard reads as an empty string, not an error.
#[tauri::command]
async fn clipboard_read_text() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let out = tokio::task::spawn_blocking(|| std::process::Command::new("pbpaste").output())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("pbpaste: {e}"))?;
        if !out.status.success() {
            return Err(format!("pbpaste exited with {}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    Err("clipboard read is only supported on macOS".into())
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

/// Attach a terminal to a host-owned pty session over SSH direct-streamlocal. Output arrives on
/// `session://data/{id}`, the ending on `session://exit/{id}`, terminal-state changes on
/// `session://meta/{id}`. A `create` mints the session first (durable, survives the app).
#[tauri::command]
async fn session_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    socket_path: String,
    token: String,
    session: String,
    write: bool,
    create: Option<SessionCreate>,
) -> Result<(), String> {
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
        .session_open(app, id, socket_path, req)
        .await
        .map_err(String::from)
}

#[tauri::command]
async fn session_write(state: State<'_, AppState>, id: String, data: Vec<u8>) -> Result<(), String> {
    state.backend().await?.session_write(&id, data).await.map_err(String::from)
}

#[tauri::command]
async fn session_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    state.backend().await?.session_resize(&id, cols, rows).await.map_err(String::from)
}

#[tauri::command]
async fn session_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.backend().await?.session_close(&id).await.map_err(String::from)
}

/// Claim the write token on an attached session; the grant arrives for every
/// subscriber as a `writer_changed` meta event, never as a direct reply.
#[tauri::command]
async fn session_take_write(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.backend().await?.session_take_write(&id).await.map_err(String::from)
}

/// List the host's sessions (name, liveness, attached count, current writer, room, command),
/// draining every page of the host's cursor-paginated listing.
#[tauri::command]
async fn session_list(
    state: State<'_, AppState>,
    socket_path: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let list = state
        .backend()
        .await?
        .session_list(socket_path, token)
        .await
        .map_err(String::from)?;
    Ok(json!(list
        .into_iter()
        .map(|s| json!({
            "name": s.name,
            "live": s.live,
            "attached": s.attached,
            "writerFde": s.writer_fde,
            "room": s.room,
            "command": s.command,
        }))
        .collect::<Vec<_>>()))
}

/// Create a host-owned session without attaching (a durable named shell).
#[tauri::command]
async fn session_new(
    state: State<'_, AppState>,
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
    state: State<'_, AppState>,
    socket_path: String,
    token: String,
    session: String,
) -> Result<(), String> {
    let reply = state
        .backend()
        .await?
        .session_control(socket_path, token, pty::Frame::Kill(session))
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
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<(), String> {
    state.backend().await?.stream_open(app, id, path).await.map_err(String::from)
}

#[tauri::command]
async fn stream_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
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
        .manage(AppState {
            backend: OnceCell::new(),
        })
        .invoke_handler(tauri::generate_handler![
            sail_request,
            connection_status,
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
