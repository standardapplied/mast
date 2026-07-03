//! Tauri entry point. The React webview (unchanged from the Electrobun build)
//! talks to this Rust core over `invoke`; the core owns the SSH session that
//! reaches the control plane and the container terminals. One `run()` serves
//! desktop (main.rs) and mobile (the `mobile_entry_point`).

mod ssh;

use serde_json::json;
use ssh::Backend;
use tauri::{AppHandle, State};
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
    match state.backend().await {
        Ok(backend) => {
            let cfg = backend.describe();
            Ok(json!({
                "phase": if backend.connected() { "ready" } else { "idle" },
                "server": format!("{}:{}", cfg.server_host, cfg.server_port),
                "sshHost": cfg.ssh_host,
                "tokenPresent": cfg.token.is_some(),
                "tokenKind": if cfg.token.is_some() { "session" } else { "none" },
                "stream": "idle",
            }))
        }
        Err(detail) => Ok(json!({
            "phase": "error",
            "server": "",
            "tokenPresent": false,
            "tokenKind": "none",
            "stream": "idle",
            "detail": detail,
        })),
    }
}

#[tauri::command]
async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let backend = state.backend().await?;
    backend
        .terminal_open(app, id, cols, rows)
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
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mast");
}
