//! Port forwards for the portal.
//!
//! A forward is a listener on this Mac's loopback whose every connection is piped, over the SSH
//! session Mast already holds to a project's container, to a port inside it. Nothing is
//! installed or configured on the Mac, and nothing listens once the backend that opened a
//! forward is retired or Mast quits: the listeners are tasks of this process.
//!
//! A port the Mac already uses is forwarded from the next free one above it, so a browser opens
//! the project's app whatever else the Mac runs.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// How many ports above the asked one a forward tries before it gives up.
const PORTS_TRIED: u16 = 50;

/// A stream a forward pipes a connection into.
pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// Opens a stream to `port` in the project's container, once per accepted connection.
pub type Connect = Arc<
    dyn Fn(u16) -> Pin<Box<dyn Future<Output = io::Result<Box<dyn Duplex>>> + Send>> + Send + Sync,
>;

struct Forward {
    local: u16,
    task: JoinHandle<()>,
}

impl Drop for Forward {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Every forward a backend keeps open, by project and container port. Retired, it has closed
/// them all and opens no more.
pub struct Forwards(Mutex<Option<HashMap<(String, u16), Forward>>>);

/// Why a forward could not be opened.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// The backend was replaced: its page is ending.
    Retired,
    /// No port from the asked one to `PORTS_TRIED` above it was free on this Mac.
    NoFreePort { port: u16 },
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Retired => write!(f, "the box changed; reopen the portal"),
            Refused::NoFreePort { port } => write!(
                f,
                "no port from {port} to {} is free on this Mac; free one and reopen the portal",
                port.saturating_add(PORTS_TRIED)
            ),
        }
    }
}

impl Forwards {
    pub fn new() -> Self {
        Forwards(Mutex::new(Some(HashMap::new())))
    }

    /// The local port `project`'s container `port` is forwarded from, opening the forward when
    /// there is none: a forward already open is kept, so reopening the portal only reopens the
    /// browser.
    pub async fn open(&self, project: &str, port: u16, connect: Connect) -> Result<u16, Refused> {
        let mut guard = self.0.lock().await;
        let open = guard.as_mut().ok_or(Refused::Retired)?;
        if let Some(forward) = open.get(&(project.to_string(), port)) {
            if !forward.task.is_finished() {
                return Ok(forward.local);
            }
        }
        let listener = bind_from(port).await?;
        let local = listener
            .local_addr()
            .map(|addr| addr.port())
            .unwrap_or(port);
        let task = tokio::spawn(accept(listener, port, connect));
        open.insert((project.to_string(), port), Forward { local, task });
        Ok(local)
    }

    /// The local port each open forward of `project` listens on, by container port.
    pub async fn of(&self, project: &str) -> HashMap<u16, u16> {
        let guard = self.0.lock().await;
        guard
            .as_ref()
            .map(|open| {
                open.iter()
                    .filter(|((owner, _), forward)| owner == project && !forward.task.is_finished())
                    .map(|((_, port), forward)| (*port, forward.local))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Closes every forward of `project`.
    pub async fn close(&self, project: &str) {
        if let Some(open) = self.0.lock().await.as_mut() {
            open.retain(|(owner, _), _| owner != project);
        }
    }

    /// Closes every forward and opens no more: the backend is being replaced.
    pub async fn retire(&self) {
        self.0.lock().await.take();
    }
}

async fn bind_from(port: u16) -> Result<TcpListener, Refused> {
    for candidate in port..=port.saturating_add(PORTS_TRIED) {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", candidate)).await {
            return Ok(listener);
        }
    }
    Err(Refused::NoFreePort { port })
}

async fn accept(listener: TcpListener, port: u16, connect: Connect) {
    while let Ok((mut socket, _)) = listener.accept().await {
        let connect = connect.clone();
        tokio::spawn(async move {
            if let Ok(mut stream) = connect(port).await {
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// A container whose `port` is an echo server on this machine: what a forward's connection
    /// reaches is what the container would serve.
    async fn echo() -> (u16, Connect) {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = server.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    while let Ok(n) = socket.read(&mut buf).await {
                        if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        let connect: Connect = Arc::new(move |_port| {
            Box::pin(async move {
                let stream = TcpStream::connect(address).await?;
                Ok(Box::new(stream) as Box<dyn Duplex>)
            })
        });
        (address.port(), connect)
    }

    async fn round_trip(local: u16, said: &[u8]) -> Vec<u8> {
        let mut client = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
        client.write_all(said).await.unwrap();
        let mut heard = vec![0u8; said.len()];
        client.read_exact(&mut heard).await.unwrap();
        heard
    }

    async fn free_port() -> u16 {
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        probe.local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn a_forward_pipes_each_connection_to_the_containers_port() {
        let (_, connect) = echo().await;
        let forwards = Forwards::new();
        let port = free_port().await;

        let local = forwards.open("acme", port, connect).await.unwrap();

        assert_eq!(local, port);
        assert_eq!(round_trip(local, b"hello").await, b"hello");
        assert_eq!(round_trip(local, b"again").await, b"again");
    }

    #[tokio::test]
    async fn a_port_the_mac_already_uses_is_forwarded_from_the_next_free_one() {
        let (_, connect) = echo().await;
        let taken = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = taken.local_addr().unwrap().port();
        let forwards = Forwards::new();

        let local = forwards.open("acme", port, connect).await.unwrap();

        assert!(local > port, "{local} is above the taken {port}");
        assert_eq!(round_trip(local, b"hi").await, b"hi");
    }

    #[tokio::test]
    async fn reopening_a_forward_keeps_it_and_its_local_port() {
        let (_, connect) = echo().await;
        let forwards = Forwards::new();
        let port = free_port().await;

        let first = forwards.open("acme", port, connect.clone()).await.unwrap();
        let again = forwards.open("acme", port, connect).await.unwrap();

        assert_eq!(first, again);
        assert_eq!(forwards.of("acme").await, HashMap::from([(port, first)]));
        assert_eq!(forwards.of("other").await, HashMap::new());
    }

    #[tokio::test]
    async fn closing_a_projects_forwards_stops_their_listeners() {
        let (_, connect) = echo().await;
        let forwards = Forwards::new();
        let port = free_port().await;
        let local = forwards.open("acme", port, connect).await.unwrap();

        forwards.close("acme").await;
        tokio::task::yield_now().await;

        assert!(
            TcpListener::bind(("127.0.0.1", local)).await.is_ok(),
            "the port is free again"
        );
        assert_eq!(forwards.of("acme").await, HashMap::new());
    }

    #[tokio::test]
    async fn a_retired_set_closes_every_forward_and_opens_no_more() {
        let (_, connect) = echo().await;
        let forwards = Forwards::new();
        let port = free_port().await;
        let local = forwards.open("acme", port, connect.clone()).await.unwrap();

        forwards.retire().await;
        tokio::task::yield_now().await;

        assert!(TcpListener::bind(("127.0.0.1", local)).await.is_ok());
        assert_eq!(
            forwards.open("acme", port, connect).await,
            Err(Refused::Retired)
        );
        assert_eq!(forwards.of("acme").await, HashMap::new());
    }

    #[tokio::test]
    async fn a_connection_the_container_refuses_is_closed_and_the_forward_keeps_listening() {
        let refusing: Connect = Arc::new(|_| {
            Box::pin(async { Err(io::Error::new(io::ErrorKind::ConnectionRefused, "no")) })
        });
        let forwards = Forwards::new();
        let port = free_port().await;
        let local = forwards.open("acme", port, refusing).await.unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
        let mut buf = [0u8; 1];
        assert_eq!(
            client.read(&mut buf).await.unwrap(),
            0,
            "the connection is closed"
        );
        assert_eq!(
            forwards.of("acme").await.len(),
            1,
            "the forward still listens"
        );
    }

    #[test]
    fn a_refusal_says_what_to_do() {
        assert_eq!(
            Refused::Retired.to_string(),
            "the box changed; reopen the portal"
        );
        assert_eq!(
            Refused::NoFreePort { port: 3000 }.to_string(),
            "no port from 3000 to 3050 is free on this Mac; free one and reopen the portal"
        );
    }
}
