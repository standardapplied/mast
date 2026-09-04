//! A field probe, not a test of record: drives the real pty host at `$SAIL_PTY_SOCK` with the
//! production attach/run code over a unix socket and prints every event. Run with
//! `SAIL_PTY_SOCK=... cargo test --lib pty_probe -- --ignored --nocapture`.
#[cfg(test)]
mod tests {
    use crate::pty::{attach, list_sessions, run, AttachRequest, CreateSpec, SessionCmd, SessionEvent};
    use std::time::Duration;
    use tokio::net::UnixStream;
    use tokio::sync::mpsc;

    #[tokio::test]
    #[ignore]
    async fn probe_create_attach_and_stream() {
        let sock = std::env::var("SAIL_PTY_SOCK").expect("SAIL_PTY_SOCK");
        let token = std::env::var("SAIL_PTY_TOKEN").unwrap_or_default();
        let cwd = std::env::var("SAIL_PTY_CWD").unwrap_or_else(|_| "/home/dev".into());
        let session = std::env::var("SAIL_PTY_SESSION").unwrap_or_else(|_| "mast-probe".into());

        let listing = list_sessions(UnixStream::connect(&sock).await.unwrap(), &token).await.unwrap();
        eprintln!("LISTING boot={} sessions={:?}", listing.host_boot_id, listing.sessions);
        let alive = listing.sessions.iter().any(|s| s.name == session && s.live);

        let stream = UnixStream::connect(&sock).await.unwrap();
        let req = AttachRequest {
            token: token.clone(),
            session: session.clone(),
            write: true,
            create: if alive {
                None
            } else {
                Some(CreateSpec {
                    command: vec!["bash".into(), "-l".into()],
                    cwd,
                    project: String::new(),
                    room: String::new(),
                    cols: 120,
                    rows: 40,
                })
            },
        };
        let stream = match attach(stream, &req).await {
            Ok(s) => s,
            Err(e) => panic!("ATTACH FAILED kind={:?} msg={e}", e.kind()),
        };
        eprintln!("ATTACHED (created={})", !alive);

        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let driver = tokio::spawn(run(stream, cmd_rx, move |ev| {
            let _ = ev_tx.send(ev);
        }));
        let pump = tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                match ev {
                    SessionEvent::Output(bytes) => {
                        eprintln!("OUTPUT {:?}", String::from_utf8_lossy(&bytes))
                    }
                    other => eprintln!("EVENT {other:?}"),
                }
            }
        });
        tokio::time::sleep(Duration::from_millis(1500)).await;
        cmd_tx.send(SessionCmd::Resize { cols: 100, rows: 30 }).await.unwrap();
        cmd_tx.send(SessionCmd::Input(b"echo probe-ok\n".to_vec())).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        cmd_tx.send(SessionCmd::Detach).await.unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(5), driver).await;
        eprintln!("DRIVER {outcome:?}");
        drop(cmd_tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), pump).await;
    }
}
