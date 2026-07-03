// Spike proof: does russh give us, IN-PROCESS (no ssh binary), the three SSH
// capabilities all of Mast needs — a PTY channel (terminal), a direct-tcpip
// forward (tunnel), and SFTP (file bridge)? If this runs green against a real
// sshd, the Rust/Tauri backend can serve connection + terminal + files on
// desktop AND mobile. Target: localhost:22 with a throwaway key.

use std::sync::Arc;

use async_trait::async_trait;
use russh::client::{self, Config, Handler};
use russh::keys::key;
use russh::keys::load_secret_key;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use tokio::io::AsyncReadExt;

struct Accept;

#[async_trait]
impl Handler for Accept {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _key: &key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key_path = std::env::args().nth(1).expect("usage: russh-proof <key> <user>");
    let user = std::env::args().nth(2).expect("usage: russh-proof <key> <user>");

    let key = load_secret_key(&key_path, None)?;
    let config = Arc::new(Config::default());
    let mut session = client::connect(config, ("127.0.0.1", 22), Accept).await?;

    let authed = session
        .authenticate_publickey(&user, Arc::new(key))
        .await?;
    assert!(authed, "publickey auth failed");
    println!("[auth]     ok — in-process russh authenticated");

    // 1) PTY channel — the terminal. Request a pty, run a command, read bytes.
    {
        let mut channel = session.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await?;
        channel.exec(true, "echo PTY_OK; tty").await?;
        let mut out = String::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => out.push_str(&String::from_utf8_lossy(&data)),
                Some(ChannelMsg::ExitStatus { .. }) => break,
                Some(ChannelMsg::Eof) => break,
                None => break,
                _ => {}
            }
        }
        assert!(out.contains("PTY_OK"), "no PTY output: {out:?}");
        let tty = out.lines().find(|l| l.contains("/dev/")).unwrap_or("(no tty)");
        println!("[terminal] ok — PTY channel live, remote tty = {}", tty.trim());
    }

    // 2) Window resize on a live shell — proves interactive terminal control.
    {
        let mut channel = session.channel_open_session().await?;
        channel.request_pty(false, "xterm-256color", 80, 24, 0, 0, &[]).await?;
        channel.request_shell(true).await?;
        channel.window_change(120, 40, 0, 0).await?;
        channel.eof().await?;
        println!("[resize]   ok — pty window_change accepted (120x40)");
    }

    // 3) direct-tcpip forward — the tunnel. Forward to sshd's own port and read
    //    its banner through the channel to prove bytes traverse the forward.
    {
        let channel = session
            .channel_open_direct_tcpip("127.0.0.1", 22, "127.0.0.1", 0)
            .await?;
        let mut stream = channel.into_stream();
        let mut buf = [0u8; 64];
        let n = stream.read(&mut buf).await?;
        let banner = String::from_utf8_lossy(&buf[..n]);
        assert!(banner.starts_with("SSH-"), "no forwarded banner: {banner:?}");
        println!("[tunnel]   ok — direct-tcpip forward carries bytes ({})", banner.trim());
    }

    // 4) SFTP — the file bridge. Write a file into the remote, read it back.
    {
        let channel = session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(channel.into_stream()).await?;
        let path = "/tmp/mast_spike_sftp.txt";
        let mut file = sftp.create(path).await?;
        use tokio::io::AsyncWriteExt;
        file.write_all(b"mast file bridge over russh-sftp\n").await?;
        file.flush().await?;
        drop(file);
        let mut readback = sftp.open(path).await?;
        let mut contents = String::new();
        readback.read_to_string(&mut contents).await?;
        assert!(contents.contains("file bridge"), "sftp readback wrong: {contents:?}");
        sftp.remove_file(path).await.ok();
        println!("[files]    ok — sftp put+get round-trip ({} bytes)", contents.len());
    }

    println!("\nALL GREEN — russh delivers terminal + tunnel + files in-process.");
    Ok(())
}
