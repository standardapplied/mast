//! Passkey login ceremony.
//!
//! WebAuthn binds to the page origin, and the sail server allow-lists exactly
//! `http://localhost:7070`. With an in-process russh session (no default
//! localhost tunnel), we stand up a temporary local forward on 127.0.0.1:7070 →
//! devbox 127.0.0.1:7070 for the duration of the ceremony, open the system
//! browser at that origin, and capture the `sess_` token the /login page hands
//! back to an ephemeral loopback receiver.

use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ssh::{Backend, Error};

const CEREMONY_TIMEOUT: Duration = Duration::from_secs(180);

pub async fn run(backend: Arc<Backend>, app: AppHandle) -> Result<(), Error> {
    backend.connect().await?; // control-plane session up (the forward rides it)
    let (server_host, origin_port) = {
        let cfg = backend.describe();
        (cfg.server_host.clone(), cfg.server_port)
    };

    // (a) The canonical page-origin port, forwarded to the devbox server. Must
    // be the allow-listed port (7070) or WebAuthn's origin check fails.
    let forward = TcpListener::bind(("127.0.0.1", origin_port)).await.map_err(|_| {
        Error::Login(format!(
            "Local port {origin_port} is busy, so sign-in can't reach the control plane. Free it and retry."
        ))
    })?;
    let forward_task = {
        let backend = backend.clone();
        let host = server_host.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = forward.accept().await {
                let backend = backend.clone();
                let host = host.clone();
                tokio::spawn(async move {
                    if let Ok(channel) = backend.open_forward(&host, origin_port).await {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                    }
                });
            }
        })
    };

    // (b) Ephemeral loopback receiver for the /login page's redirect.
    let callback = TcpListener::bind("127.0.0.1:0").await.map_err(|e| Error::Login(e.to_string()))?;
    let cb_port = callback.local_addr().map_err(|e| Error::Login(e.to_string()))?.port();
    let state = random_hex();

    // (c) Open the system browser at the canonical origin (localhost is a
    // WebAuthn secure-context exception; the redirect_uri uses 127.0.0.1 to
    // match the server's loopback regex).
    let page_host = if server_host == "127.0.0.1" { "localhost" } else { &server_host };
    let url = format!(
        "http://{page_host}:{origin_port}/login?redirect_uri=http://127.0.0.1:{cb_port}/callback&state={state}"
    );
    let opened = app.opener().open_url(url, None::<&str>);

    let outcome = tokio::time::timeout(CEREMONY_TIMEOUT, await_callback(callback, &state)).await;
    forward_task.abort();
    opened.map_err(|e| Error::Login(e.to_string()))?;

    let token = outcome.map_err(|_| Error::Login("Sign-in timed out — no callback received.".into()))??;
    backend.set_token(Some(token)).await?;
    Ok(())
}

/// Accept callbacks until a valid one arrives. A bad hit answers 400 but does
/// NOT resolve — a stray local probe must not cancel an in-flight sign-in.
async fn await_callback(listener: TcpListener, state: &str) -> Result<String, Error> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| Error::Login(e.to_string()))?;
        let mut buf = vec![0u8; 4096];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let line = request.lines().next().unwrap_or("");
        let path = line.split_whitespace().nth(1).unwrap_or("");

        if !line.starts_with("GET ") || !path.starts_with("/callback") {
            respond(&mut sock, "404 Not Found", "text/plain", "not found").await;
            continue;
        }
        let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let token = query_param(query, "token");
        let got_state = query_param(query, "state");
        let state_ok = got_state
            .as_deref()
            .is_some_and(|s| constant_time_eq(s.as_bytes(), state.as_bytes()));
        let token_ok = token.as_deref().is_some_and(|t| t.starts_with("sess_"));
        if !state_ok || !token_ok {
            respond(&mut sock, "400 Bad Request", "text/plain", "bad request").await;
            continue; // do not settle
        }
        respond(
            &mut sock,
            "200 OK",
            "text/html; charset=utf-8",
            "<!doctype html><meta charset=utf-8><body style=\"font:15px system-ui;padding:3rem\">Signed in — return to Mast.</body>",
        )
        .await;
        return Ok(token.unwrap());
    }
}

async fn respond(sock: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
    let _ = sock.flush().await;
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("os rng");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
