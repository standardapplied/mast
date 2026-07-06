//! Tauri entry point. The React webview (unchanged from the Electrobun build)
//! talks to this Rust core over `invoke`; the core owns the SSH session that
//! reaches the control plane and the container terminals. One `run()` serves
//! desktop (main.rs) and mobile (the `mobile_entry_point`).

mod ssh;

use serde_json::json;
use ssh::Backend;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::OnceCell;

/// Lazily-built backend. Construction reads `~/.sail/config.yaml`; if that is
/// missing the app still renders (demo/disconnected) and the first real call
/// surfaces a clear error instead of panicking at startup.
struct AppState {
    backend: OnceCell<Backend>,
}

impl AppState {
    async fn backend(&self) -> Result<&Backend, String> {
        self.backend
            .get_or_try_init(|| async { Backend::new().map_err(String::from) })
            .await
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

    let connected = backend.connect().await;
    let cfg = backend.describe();
    let mut status = json!({
        "server": format!("{}:{}", cfg.server_host, cfg.server_port),
        "sshHost": cfg.ssh_host,
        "tokenPresent": cfg.token.is_some(),
        // `sess_` = passkey-login session; anything else is a long-lived API token.
        "tokenKind": match cfg.token.as_deref() {
            Some(t) if t.starts_with("sess_") => "session",
            Some(_) => "api",
            None => "none",
        },
    });
    match connected {
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

#[tauri::command]
async fn fs_read(state: State<'_, AppState>, target: String, path: String) -> Result<Vec<u8>, String> {
    state.backend().await?.fs_read(&target, path).await.map_err(String::from)
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

#[tauri::command]
async fn fs_write(
    state: State<'_, AppState>,
    target: String,
    path: String,
    contents: Vec<u8>,
) -> Result<(), String> {
    state.backend().await?.fs_write(&target, path, contents).await.map_err(String::from)
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
async fn fs_delete(state: State<'_, AppState>, target: String, path: String) -> Result<(), String> {
    state.backend().await?.fs_delete(&target, path).await.map_err(String::from)
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

#[tauri::command]
async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    target: Option<String>,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let backend = state.backend().await?;
    backend
        .terminal_open(app, id, target, cols, rows)
        .await
        .map_err(String::from)
}

#[tauri::command]
async fn terminal_write(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    state.backend().await?.terminal_write(&id, data).await.map_err(String::from)
}

#[tauri::command]
async fn terminal_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    state.backend().await?.terminal_resize(&id, cols, rows).await.map_err(String::from)
}

#[tauri::command]
async fn terminal_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.backend().await?.terminal_close(&id).await.map_err(String::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            backend: OnceCell::new(),
        })
        .invoke_handler(tauri::generate_handler![
            sail_request,
            connection_status,
            list_targets,
            fs_list,
            fs_read,
            fs_upload,
            fs_download,
            fs_write,
            fs_rename,
            fs_mkdir,
            fs_delete,
            fs_open,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mast");
}
