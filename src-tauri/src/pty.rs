//! Wire framing for the sail pty session host protocol, byte-compatible with the
//! Java `ai.singlr.sail.pty.PtyWire`: an 8-byte magic handshake, then
//! length-prefixed frames (`i32` length, `u8` type, payload). Integers are
//! big-endian; strings and byte blobs are an `i32` length followed by the raw
//! bytes. This module is pure framing — the async transport that carries it over
//! an SSH direct-streamlocal channel lives with the terminal backend.

#![allow(dead_code)]

/// Handshake magic; each peer writes it and must read the other's back.
pub const MAGIC: &[u8; 8] = b"SAILPTY3";

/// The magics older sail hosts present; recognized so the skew can be named.
const OLDER_MAGICS: [&[u8; 8]; 2] = [b"SAILPTY1", b"SAILPTY2"];

/// Frames larger than this are a protocol violation, refused rather than trusted.
pub const MAX_FRAME: usize = 1 << 20;

/// The host clamps a session listing page to this many entries.
pub const PAGE_LIMIT: u32 = 16;

/// One session as the host lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub name: String,
    pub live: bool,
    pub attached: u32,
    pub writer_fde: String,
    pub room: String,
    pub command: Vec<String>,
}

/// A protocol frame in either direction. The client sends the request forms and
/// receives the notification forms; both are modeled so the codec round-trips.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Hello(String),
    /// The host's answer to an admitted Hello: the boot id of this run of the host process.
    Welcome(String),
    Create {
        session: String,
        command: Vec<String>,
        cwd: String,
        project: String,
        room: String,
        cols: u32,
        rows: u32,
    },
    Attach {
        session: String,
        write: bool,
    },
    Input {
        seq: i64,
        bytes: Vec<u8>,
    },
    Resize {
        cols: u32,
        rows: u32,
    },
    TakeWrite,
    Detach,
    ListSessions {
        after: String,
        limit: u32,
    },
    Kill(String),
    Output {
        last_input_seq: i64,
        bytes: Vec<u8>,
    },
    ReplayBegin {
        safe: bool,
    },
    ReplayEnd,
    WriterChanged(String),
    Resized {
        cols: u32,
        rows: u32,
    },
    Paused,
    Continued,
    SessionEnded(String),
    SessionInfo(SessionInfo),
    Sessions {
        sessions: Vec<SessionInfo>,
        next: String,
    },
    Ok,
    Err(String),
}

/// A decode failure: a short/garbled payload or an unknown frame type.
#[derive(Debug, PartialEq, Eq)]
pub struct DecodeError(pub String);

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for DecodeError {}

/// Encodes a frame to its full wire form: the `i32` length prefix followed by the
/// payload the peer decodes.
pub fn encode(frame: &Frame) -> Vec<u8> {
    let mut p = Vec::with_capacity(64);
    match frame {
        Frame::Hello(token) => {
            p.push(9);
            put_str(&mut p, token);
        }
        Frame::Create {
            session,
            command,
            cwd,
            project,
            room,
            cols,
            rows,
        } => {
            p.push(1);
            put_str(&mut p, session);
            put_str_list(&mut p, command);
            put_str(&mut p, cwd);
            put_str(&mut p, project);
            put_str(&mut p, room);
            put_i32(&mut p, *cols as i32);
            put_i32(&mut p, *rows as i32);
        }
        Frame::Attach { session, write } => {
            p.push(2);
            put_str(&mut p, session);
            p.push(if *write { 1 } else { 0 });
        }
        Frame::Input { seq, bytes } => {
            p.push(3);
            p.extend_from_slice(&seq.to_be_bytes());
            put_bytes(&mut p, bytes);
        }
        Frame::Resize { cols, rows } => {
            p.push(4);
            put_i32(&mut p, *cols as i32);
            put_i32(&mut p, *rows as i32);
        }
        Frame::TakeWrite => p.push(5),
        Frame::Detach => p.push(6),
        Frame::ListSessions { after, limit } => {
            p.push(7);
            put_str(&mut p, after);
            put_i32(&mut p, *limit as i32);
        }
        Frame::Kill(session) => {
            p.push(8);
            put_str(&mut p, session);
        }
        Frame::Output {
            last_input_seq,
            bytes,
        } => {
            p.push(20);
            p.extend_from_slice(&last_input_seq.to_be_bytes());
            put_bytes(&mut p, bytes);
        }
        Frame::ReplayBegin { safe } => {
            p.push(21);
            p.push(if *safe { 1 } else { 0 });
        }
        Frame::ReplayEnd => p.push(22),
        Frame::WriterChanged(fde) => {
            p.push(23);
            put_str(&mut p, fde);
        }
        Frame::Resized { cols, rows } => {
            p.push(24);
            put_i32(&mut p, *cols as i32);
            put_i32(&mut p, *rows as i32);
        }
        Frame::Paused => p.push(25),
        Frame::Continued => p.push(26),
        Frame::SessionEnded(reason) => {
            p.push(27);
            put_str(&mut p, reason);
        }
        Frame::SessionInfo(info) => {
            p.push(28);
            put_info(&mut p, info);
        }
        Frame::Sessions { sessions, next } => {
            p.push(29);
            put_i32(&mut p, sessions.len() as i32);
            for info in sessions {
                put_info(&mut p, info);
            }
            put_str(&mut p, next);
        }
        Frame::Ok => p.push(30),
        Frame::Err(message) => {
            p.push(31);
            put_str(&mut p, message);
        }
        Frame::Welcome(host_boot_id) => {
            p.push(32);
            put_str(&mut p, host_boot_id);
        }
    }
    let mut out = Vec::with_capacity(4 + p.len());
    put_i32(&mut out, p.len() as i32);
    out.extend_from_slice(&p);
    out
}

/// Decodes one payload (the framed length already stripped) into a frame.
pub fn decode(payload: &[u8]) -> Result<Frame, DecodeError> {
    let mut c = Cursor::new(payload);
    let frame = match c.u8()? {
        9 => Frame::Hello(c.string()?),
        1 => Frame::Create {
            session: c.string()?,
            command: c.string_list()?,
            cwd: c.string()?,
            project: c.string()?,
            room: c.string()?,
            cols: c.i32()? as u32,
            rows: c.i32()? as u32,
        },
        2 => Frame::Attach {
            session: c.string()?,
            write: c.u8()? == 1,
        },
        3 => Frame::Input {
            seq: c.i64()?,
            bytes: c.bytes()?,
        },
        4 => Frame::Resize {
            cols: c.i32()? as u32,
            rows: c.i32()? as u32,
        },
        5 => Frame::TakeWrite,
        6 => Frame::Detach,
        7 => Frame::ListSessions {
            after: c.string()?,
            limit: c.i32()? as u32,
        },
        8 => Frame::Kill(c.string()?),
        20 => Frame::Output {
            last_input_seq: c.i64()?,
            bytes: c.bytes()?,
        },
        21 => Frame::ReplayBegin { safe: c.u8()? == 1 },
        22 => Frame::ReplayEnd,
        23 => Frame::WriterChanged(c.string()?),
        24 => Frame::Resized {
            cols: c.i32()? as u32,
            rows: c.i32()? as u32,
        },
        25 => Frame::Paused,
        26 => Frame::Continued,
        27 => Frame::SessionEnded(c.string()?),
        28 => Frame::SessionInfo(c.info()?),
        29 => {
            let count = c.i32()?;
            let mut sessions = Vec::new();
            for _ in 0..count {
                sessions.push(c.info()?);
            }
            Frame::Sessions {
                sessions,
                next: c.string()?,
            }
        }
        30 => Frame::Ok,
        31 => Frame::Err(c.string()?),
        32 => Frame::Welcome(c.string()?),
        other => return Err(DecodeError(format!("unknown pty frame type {other}"))),
    };
    Ok(frame)
}

fn put_i32(buf: &mut Vec<u8>, value: i32) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn put_bytes(buf: &mut Vec<u8>, bytes: &[u8]) {
    put_i32(buf, bytes.len() as i32);
    buf.extend_from_slice(bytes);
}

fn put_str(buf: &mut Vec<u8>, s: &str) {
    put_bytes(buf, s.as_bytes());
}

fn put_str_list(buf: &mut Vec<u8>, list: &[String]) {
    put_i32(buf, list.len() as i32);
    for s in list {
        put_str(buf, s);
    }
}

fn put_info(buf: &mut Vec<u8>, info: &SessionInfo) {
    put_str(buf, &info.name);
    buf.push(if info.live { 1 } else { 0 });
    put_i32(buf, info.attached as i32);
    put_str(buf, &info.writer_fde);
    put_str(buf, &info.room);
    put_str_list(buf, &info.command);
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Cursor { data, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if self.pos + n > self.data.len() {
            return Err(DecodeError("pty frame is truncated".into()));
        }
        let slice = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }

    fn i32(&mut self) -> Result<i32, DecodeError> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i64(&mut self) -> Result<i64, DecodeError> {
        Ok(i64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn bytes(&mut self) -> Result<Vec<u8>, DecodeError> {
        let len = self.i32()?;
        if len < 0 {
            return Err(DecodeError("negative length in pty frame".into()));
        }
        Ok(self.take(len as usize)?.to_vec())
    }

    fn string(&mut self) -> Result<String, DecodeError> {
        String::from_utf8(self.bytes()?)
            .map_err(|_| DecodeError("invalid utf-8 in pty frame".into()))
    }

    fn string_list(&mut self) -> Result<Vec<String>, DecodeError> {
        let count = self.i32()?;
        if count < 0 {
            return Err(DecodeError("negative count in pty frame".into()));
        }
        let mut list = Vec::new();
        for _ in 0..count {
            list.push(self.string()?);
        }
        Ok(list)
    }

    fn info(&mut self) -> Result<SessionInfo, DecodeError> {
        Ok(SessionInfo {
            name: self.string()?,
            live: self.u8()? == 1,
            attached: self.i32()? as u32,
            writer_fde: self.string()?,
            room: self.string()?,
            command: self.string_list()?,
        })
    }
}

use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

/// Writes one framed message to a stream and flushes it (SSH channels stream on flush).
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, frame: &Frame) -> io::Result<()> {
    w.write_all(&encode(frame)).await?;
    w.flush().await
}

/// Reads one framed message, enforcing the frame cap so a garbled length can never allocate wildly.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Frame> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = i32::from_be_bytes(len_buf);
    if len < 1 || len as usize > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("refusing a pty frame of {len} bytes"),
        ));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload).await?;
    decode(&payload).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.0))
}

/// The version-skew reason strings the webview matches to render a skew card;
/// keep them in lockstep with `skewOf` in `src/mainview/terminal/roomDeck.ts`.
pub const SKEW_HOST_OLDER: &str = "pty protocol skew: the box speaks an older SAILPTY";
pub const SKEW_CLIENT_OLDER: &str = "pty protocol skew: the box no longer speaks SAILPTY3";

/// The magic handshake: send ours, require the peer's back. Symmetric, so both ends call it.
/// A mismatch names which side is behind: an echo of an older magic means the box's sail
/// predates this Mast; anything else means the box has moved past SAILPTY3.
pub async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> io::Result<()> {
    s.write_all(MAGIC).await?;
    s.flush().await?;
    let mut peer = [0u8; 8];
    s.read_exact(&mut peer).await?;
    if &peer == MAGIC {
        return Ok(());
    }
    let skew = if OLDER_MAGICS.contains(&&peer) {
        SKEW_HOST_OLDER
    } else {
        SKEW_CLIENT_OLDER
    };
    Err(io::Error::new(io::ErrorKind::InvalidData, skew))
}

/// What the terminal widget sends toward a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionCmd {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    TakeWrite,
    Detach,
}

/// What a session emits toward the widget — the wire frames, mapped to intent (no `Frame` leaks
/// past the driver, so the UI never couples to the protocol encoding).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Replaying { safe: bool },
    ReplayDone,
    Output(Vec<u8>),
    Paused,
    Continued,
    WriterChanged(String),
    Resized { cols: u32, rows: u32 },
    Ended(String),
}

/// A session to create before attaching (a fresh named shell); absent means attach to an existing one.
#[derive(Debug, Clone)]
pub struct CreateSpec {
    pub command: Vec<String>,
    pub cwd: String,
    pub project: String,
    pub room: String,
    pub cols: u32,
    pub rows: u32,
}

/// Everything needed to reach a session: the FDE token (empty = the box owner), the session name,
/// whether to hold the write token, and an optional create-then-attach.
#[derive(Debug, Clone)]
pub struct AttachRequest {
    pub token: String,
    pub session: String,
    pub write: bool,
    pub create: Option<CreateSpec>,
}

/// Drives one attached session over {@code stream} until the session ends or a detach is commanded:
/// the [`attach`] prologue, then the [`run`] steady state.
///
/// The transport is abstract (`AsyncRead + AsyncWrite`), so this same logic runs over an SSH
/// direct-streamlocal channel in production and a `tokio::io::duplex` in tests. Input frames carry a
/// monotonic sequence — the enabler for client-side predictive echo — echoed back on output.
pub async fn drive<S, F>(
    stream: S,
    req: AttachRequest,
    cmds: mpsc::Receiver<SessionCmd>,
    on_event: F,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: FnMut(SessionEvent),
{
    let stream = attach(stream, &req).await?;
    run(stream, cmds, on_event).await
}

/// The strictly request/reply prologue: handshake, identify, create when asked, attach. Returns
/// the stream once the host has acknowledged the attach — a caller that awaits this knows the
/// session exists before anyone treats the create as spent.
pub async fn attach<S>(mut stream: S, req: &AttachRequest) -> io::Result<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    handshake(&mut stream).await?;
    write_frame(&mut stream, &Frame::Hello(req.token.clone())).await?;
    expect_welcome(&mut stream).await?;

    if let Some(spec) = &req.create {
        write_frame(
            &mut stream,
            &Frame::Create {
                session: req.session.clone(),
                command: spec.command.clone(),
                cwd: spec.cwd.clone(),
                project: spec.project.clone(),
                room: spec.room.clone(),
                cols: spec.cols,
                rows: spec.rows,
            },
        )
        .await?;
        expect_ok(&mut stream, "create").await?;
    }

    write_frame(
        &mut stream,
        &Frame::Attach {
            session: req.session.clone(),
            write: req.write,
        },
    )
    .await?;
    expect_ok(&mut stream, "attach").await?;
    Ok(stream)
}

/// The steady state of an attached session: host frames become events, UI commands become
/// frames, until the session ends or a detach is commanded.
pub async fn run<S, F>(stream: S, mut cmds: mpsc::Receiver<SessionCmd>, mut on_event: F) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: FnMut(SessionEvent),
{
    // The prologue is strictly request/reply, but the steady state must await a
    // host frame and a UI command at once. `read_frame` is NOT cancel-safe
    // (its inner `read_exact` can drop already-consumed bytes if a `select!`
    // arm loses), so reads run in their own task that owns the read half and
    // forwards whole frames over a cancel-safe channel. The select then only
    // ever races two cancel-safe receivers.
    let (mut rd, mut wr) = tokio::io::split(stream);
    let (frame_tx, mut frame_rx) = mpsc::channel::<io::Result<Frame>>(64);
    let _reader = AbortOnDrop(tokio::spawn(async move {
        loop {
            match read_frame(&mut rd).await {
                Ok(frame) => {
                    if frame_tx.send(Ok(frame)).await.is_err() {
                        return;
                    }
                }
                Err(e) => {
                    let _ = frame_tx.send(Err(e)).await;
                    return;
                }
            }
        }
    }));

    let mut seq: i64 = 0;
    loop {
        tokio::select! {
            incoming = frame_rx.recv() => {
                let frame = match incoming {
                    Some(Ok(frame)) => frame,
                    Some(Err(e)) => return Err(e),
                    None => return Ok(()),
                };
                match frame {
                    Frame::Output { bytes, .. } => on_event(SessionEvent::Output(bytes)),
                    Frame::ReplayBegin { safe } => on_event(SessionEvent::Replaying { safe }),
                    Frame::ReplayEnd => on_event(SessionEvent::ReplayDone),
                    Frame::Paused => on_event(SessionEvent::Paused),
                    Frame::Continued => on_event(SessionEvent::Continued),
                    Frame::WriterChanged(fde) => on_event(SessionEvent::WriterChanged(fde)),
                    Frame::Resized { cols, rows } => on_event(SessionEvent::Resized { cols, rows }),
                    Frame::SessionEnded(reason) => {
                        on_event(SessionEvent::Ended(reason));
                        return Ok(());
                    }
                    _ => {}
                }
            }
            cmd = cmds.recv() => match cmd {
                Some(SessionCmd::Input(bytes)) => {
                    seq += 1;
                    write_frame(&mut wr, &Frame::Input { seq, bytes }).await?;
                }
                Some(SessionCmd::Resize { cols, rows }) => {
                    write_frame(&mut wr, &Frame::Resize { cols, rows }).await?;
                }
                Some(SessionCmd::TakeWrite) => {
                    write_frame(&mut wr, &Frame::TakeWrite).await?;
                }
                Some(SessionCmd::Detach) | None => {
                    let _ = write_frame(&mut wr, &Frame::Detach).await;
                    return Ok(());
                }
            }
        }
    }
}

/// Aborts a spawned task when the driver returns, so a reader parked on a quiet
/// stream never outlives the session it was reading for.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Reads the Hello reply, which must be `Welcome` carrying the host's boot id — the same error
/// discipline as [`expect_ok`]: a refusal is `PermissionDenied` with the host's message.
async fn expect_welcome<S: AsyncRead + Unpin>(s: &mut S) -> io::Result<String> {
    match read_frame(s).await? {
        Frame::Welcome(host_boot_id) => Ok(host_boot_id),
        Frame::Err(message) => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("hello: {message}"),
        )),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("hello: unexpected reply {other:?}"),
        )),
    }
}

/// Reads one control reply that must be `Ok`, turning `Err`/unexpected frames into an I/O error
/// carrying the host's own message — so a refusal (bad token, foreign session) surfaces verbatim.
/// A refusal is minted as `PermissionDenied` so the caller can tell "the host said no" (retrying
/// the same request can only fail the same way) from a transport failure (retrying reattaches).
async fn expect_ok<S: AsyncRead + Unpin>(s: &mut S, verb: &str) -> io::Result<()> {
    match read_frame(s).await? {
        Frame::Ok => Ok(()),
        Frame::Err(message) => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{verb}: {message}"),
        )),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{verb}: unexpected reply {other:?}"),
        )),
    }
}

/// Opens a short-lived control connection, identifies, sends one request, and returns its reply —
/// the list/kill/create-without-attach path. The caller supplies the stream (an SSH channel in
/// production, a duplex in tests).
pub async fn control<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    token: &str,
    request: Frame,
) -> io::Result<Frame> {
    handshake(&mut stream).await?;
    write_frame(&mut stream, &Frame::Hello(token.to_string())).await?;
    expect_welcome(&mut stream).await?;
    write_frame(&mut stream, &request).await?;
    read_frame(&mut stream).await
}

/// The host's listing: every session it admits the caller to, and the boot id the host answered
/// under — the fact that turns "absent" into "host restarted" when it changes between listings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub host_boot_id: String,
    pub sessions: Vec<SessionInfo>,
}

/// The most sessions a listing drain will accumulate before refusing: a real box holds
/// dozens, so a listing still growing past this is a broken or hostile host feeding
/// endless pages, not data worth buffering.
pub const MAX_LISTED_SESSIONS: usize = 4096;

/// Opens a control connection and drains every page of the host's session listing,
/// feeding each `next` cursor back until the host reports the last page. A cursor
/// that fails to advance is refused rather than looped on, and the aggregate is
/// bounded by [`MAX_LISTED_SESSIONS`].
pub async fn list_sessions<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    token: &str,
) -> io::Result<Listing> {
    handshake(&mut stream).await?;
    write_frame(&mut stream, &Frame::Hello(token.to_string())).await?;
    let host_boot_id = expect_welcome(&mut stream).await?;
    let mut all = Vec::new();
    let mut after = String::new();
    loop {
        let request = Frame::ListSessions {
            after: after.clone(),
            limit: PAGE_LIMIT,
        };
        write_frame(&mut stream, &request).await?;
        match read_frame(&mut stream).await? {
            Frame::Sessions { sessions, next } => {
                all.extend(sessions);
                if all.len() > MAX_LISTED_SESSIONS {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "the host listed more than {MAX_LISTED_SESSIONS} sessions; refusing an unbounded listing"
                        ),
                    ));
                }
                if next.is_empty() {
                    return Ok(Listing {
                        host_boot_id,
                        sessions: all,
                    });
                }
                if next <= after {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the host's session listing cursor went backwards; refusing to loop",
                    ));
                }
                after = next;
            }
            Frame::Err(message) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("list: {message}"),
                ))
            }
            other => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("list: unexpected reply {other:?}"),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(frame: Frame) {
        let wire = encode(&frame);
        let len = i32::from_be_bytes(wire[0..4].try_into().unwrap()) as usize;
        assert_eq!(len, wire.len() - 4, "length prefix matches the payload");
        assert_eq!(
            decode(&wire[4..]).unwrap(),
            frame,
            "frame survives the wire"
        );
    }

    #[test]
    fn every_frame_survives_the_wire() {
        roundtrip(Frame::Hello("tok-uday".into()));
        roundtrip(Frame::Create {
            session: "lounge".into(),
            command: vec!["bash".into(), "-l".into()],
            cwd: "/home/dev".into(),
            project: "chorus".into(),
            room: "design-talk".into(),
            cols: 132,
            rows: 43,
        });
        roundtrip(Frame::Attach {
            session: "s1".into(),
            write: true,
        });
        roundtrip(Frame::Input {
            seq: 42,
            bytes: vec![0, 1, 27, 255],
        });
        roundtrip(Frame::Resize { cols: 80, rows: 24 });
        roundtrip(Frame::TakeWrite);
        roundtrip(Frame::Detach);
        roundtrip(Frame::ListSessions {
            after: "mast-node".into(),
            limit: 16,
        });
        roundtrip(Frame::Kill("s1".into()));
        roundtrip(Frame::Output {
            last_input_seq: 7,
            bytes: b"hello\x1b[0m".to_vec(),
        });
        roundtrip(Frame::ReplayBegin { safe: true });
        roundtrip(Frame::ReplayEnd);
        roundtrip(Frame::WriterChanged("mady".into()));
        roundtrip(Frame::Resized {
            cols: 100,
            rows: 30,
        });
        roundtrip(Frame::Paused);
        roundtrip(Frame::Continued);
        roundtrip(Frame::SessionEnded("exited(0)".into()));
        roundtrip(Frame::Sessions {
            sessions: vec![
                SessionInfo {
                    name: "a".into(),
                    live: true,
                    attached: 2,
                    writer_fde: "uday".into(),
                    room: "design-talk".into(),
                    command: vec!["claude".into()],
                },
                SessionInfo {
                    name: "b".into(),
                    live: false,
                    attached: 0,
                    writer_fde: String::new(),
                    room: String::new(),
                    command: vec!["bash".into(), "-l".into()],
                },
            ],
            next: "b".into(),
        });
        roundtrip(Frame::Ok);
        roundtrip(Frame::Welcome("boot-7".into()));
        roundtrip(Frame::Err("boom".into()));
    }

    #[test]
    fn hello_bytes_match_the_java_contract() {
        // type 9, then string "x": i32 len=1, byte 'x' — payload of 6 bytes.
        assert_eq!(
            encode(&Frame::Hello("x".into())),
            vec![0, 0, 0, 6, 9, 0, 0, 0, 1, b'x'],
        );
    }

    #[test]
    fn input_bytes_match_the_java_contract() {
        // type 3, i64 seq=1, then bytes: i32 len=2, 'h','i'.
        assert_eq!(
            encode(&Frame::Input {
                seq: 1,
                bytes: b"hi".to_vec(),
            }),
            vec![0, 0, 0, 15, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, b'h', b'i'],
        );
    }

    #[test]
    fn create_bytes_match_the_java_contract() {
        // type 1, str session, string-list command, str cwd, str project,
        // str room (v2: between project and cols), i32 cols, i32 rows.
        let frame = Frame::Create {
            session: "s".into(),
            command: vec!["claude".into()],
            cwd: "/h".into(),
            project: "p".into(),
            room: "r".into(),
            cols: 80,
            rows: 24,
        };
        #[rustfmt::skip]
        let wire = vec![
            0, 0, 0, 44,
            1,
            0, 0, 0, 1, b's',
            0, 0, 0, 1,
            0, 0, 0, 6, b'c', b'l', b'a', b'u', b'd', b'e',
            0, 0, 0, 2, b'/', b'h',
            0, 0, 0, 1, b'p',
            0, 0, 0, 1, b'r',
            0, 0, 0, 80,
            0, 0, 0, 24,
        ];
        assert_eq!(encode(&frame), wire);
    }

    #[test]
    fn list_sessions_bytes_match_the_java_contract() {
        // type 7, str after (exclusive cursor), i32 limit.
        let frame = Frame::ListSessions {
            after: "a".into(),
            limit: 16,
        };
        assert_eq!(
            encode(&frame),
            vec![0, 0, 0, 10, 7, 0, 0, 0, 1, b'a', 0, 0, 0, 16],
        );
    }

    #[test]
    fn sessions_bytes_match_the_java_contract() {
        // type 29, i32 count, then per entry: str name, u8 live, i32 attached,
        // str writerFde, str room, string-list command; a trailing str next cursor.
        let frame = Frame::Sessions {
            sessions: vec![SessionInfo {
                name: "a".into(),
                live: true,
                attached: 2,
                writer_fde: "u".into(),
                room: "r".into(),
                command: vec!["bash".into(), "-l".into()],
            }],
            next: "a".into(),
        };
        #[rustfmt::skip]
        let wire = vec![
            0, 0, 0, 48,
            29,
            0, 0, 0, 1,
            0, 0, 0, 1, b'a',
            1,
            0, 0, 0, 2,
            0, 0, 0, 1, b'u',
            0, 0, 0, 1, b'r',
            0, 0, 0, 2,
            0, 0, 0, 4, b'b', b'a', b's', b'h',
            0, 0, 0, 2, b'-', b'l',
            0, 0, 0, 1, b'a',
        ];
        assert_eq!(encode(&frame), wire);
        assert_eq!(decode(&wire[4..]).unwrap(), frame);
    }

    #[test]
    fn a_truncated_payload_is_an_error_not_a_panic() {
        assert!(decode(&[9, 0, 0, 0, 5, b'x']).is_err());
        assert!(decode(&[]).is_err());
    }

    #[test]
    fn an_unknown_type_is_refused() {
        let err = decode(&[99]).unwrap_err();
        assert!(err.0.contains("99"));
    }
}


#[cfg(test)]
mod async_tests {
    use super::*;
    use tokio::io::duplex;
    use tokio::sync::mpsc;

    /// A minimal host that speaks the server side of the protocol, for driving the client headlessly.
    async fn host_handshake_hello<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> Frame {
        handshake(s).await.unwrap();
        let hello = read_frame(s).await.unwrap();
        write_frame(s, &Frame::Welcome("boot-1".into())).await.unwrap();
        hello
    }

    #[tokio::test]
    async fn frames_round_trip_over_a_stream() {
        let (mut a, mut b) = duplex(1024);
        for frame in [
            Frame::Hello("t".into()),
            Frame::Input { seq: 5, bytes: b"xy".to_vec() },
            Frame::Output { last_input_seq: 5, bytes: b"z".to_vec() },
            Frame::SessionEnded("bye".into()),
        ] {
            write_frame(&mut a, &frame).await.unwrap();
            assert_eq!(read_frame(&mut b).await.unwrap(), frame);
        }
    }

    #[tokio::test]
    async fn handshake_accepts_a_peer_and_rejects_a_stranger() {
        let (mut a, mut b) = duplex(64);
        let ok = tokio::spawn(async move { handshake(&mut b).await });
        handshake(&mut a).await.unwrap();
        ok.await.unwrap().unwrap();

        let (mut a2, mut b2) = duplex(64);
        let evil = tokio::spawn(async move {
            b2.write_all(b"NOTSAIL1").await.unwrap();
            b2.flush().await.unwrap();
        });
        assert!(handshake(&mut a2).await.is_err());
        evil.await.unwrap();
    }

    #[tokio::test]
    async fn a_v1_peer_is_named_as_the_older_side() {
        let (mut client, mut host) = duplex(64);
        let v1 = tokio::spawn(async move {
            host.write_all(b"SAILPTY1").await.unwrap();
            host.flush().await.unwrap();
        });
        let err = handshake(&mut client).await.unwrap_err();
        assert_eq!(err.to_string(), SKEW_HOST_OLDER);
        v1.await.unwrap();
    }

    #[tokio::test]
    async fn a_v2_peer_predates_the_boot_id_and_is_the_older_side() {
        let (mut client, mut host) = duplex(64);
        let v2 = tokio::spawn(async move {
            host.write_all(b"SAILPTY2").await.unwrap();
            host.flush().await.unwrap();
        });
        let err = handshake(&mut client).await.unwrap_err();
        assert_eq!(err.to_string(), SKEW_HOST_OLDER);
        v2.await.unwrap();
    }

    #[tokio::test]
    async fn an_unknown_magic_means_this_client_is_the_older_side() {
        let (mut client, mut host) = duplex(64);
        let v4 = tokio::spawn(async move {
            host.write_all(b"SAILPTY4").await.unwrap();
            host.flush().await.unwrap();
        });
        let err = handshake(&mut client).await.unwrap_err();
        assert_eq!(err.to_string(), SKEW_CLIENT_OLDER);
        v4.await.unwrap();
    }

    #[tokio::test]
    async fn a_hello_answered_without_a_welcome_is_invalid_not_a_refusal() {
        let (client, mut server) = duplex(1024);
        let host = tokio::spawn(async move {
            handshake(&mut server).await.unwrap();
            read_frame(&mut server).await.unwrap(); // Hello
            write_frame(&mut server, &Frame::Ok).await.unwrap();
        });
        let err = list_sessions(client, "tok").await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("unexpected reply"), "{err}");
        host.await.unwrap();
    }

    #[tokio::test]
    async fn drive_identifies_attaches_replays_streams_and_forwards_input() {
        let (client, mut server) = duplex(4096);
        let host = tokio::spawn(async move {
            let hello = host_handshake_hello(&mut server).await;
            assert_eq!(hello, Frame::Hello("tok".into()));
            assert_eq!(read_frame(&mut server).await.unwrap(), Frame::Attach { session: "s1".into(), write: true });
            write_frame(&mut server, &Frame::Ok).await.unwrap();
            write_frame(&mut server, &Frame::ReplayBegin { safe: true }).await.unwrap();
            write_frame(&mut server, &Frame::Output { last_input_seq: -1, bytes: b"history".to_vec() }).await.unwrap();
            write_frame(&mut server, &Frame::ReplayEnd).await.unwrap();
            // The client's keystroke arrives as an Input frame carrying seq 1.
            assert_eq!(read_frame(&mut server).await.unwrap(), Frame::Input { seq: 1, bytes: b"ls\n".to_vec() });
            write_frame(&mut server, &Frame::Output { last_input_seq: 1, bytes: b"live".to_vec() }).await.unwrap();
            write_frame(&mut server, &Frame::SessionEnded("exited(0)".into())).await.unwrap();
        });

        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let driver = tokio::spawn(async move {
            drive(
                client,
                AttachRequest { token: "tok".into(), session: "s1".into(), write: true, create: None },
                cmd_rx,
                move |ev| { let _ = ev_tx.send(ev); },
            )
            .await
        });

        assert_eq!(ev_rx.recv().await.unwrap(), SessionEvent::Replaying { safe: true });
        assert_eq!(ev_rx.recv().await.unwrap(), SessionEvent::Output(b"history".to_vec()));
        assert_eq!(ev_rx.recv().await.unwrap(), SessionEvent::ReplayDone);
        cmd_tx.send(SessionCmd::Input(b"ls\n".to_vec())).await.unwrap();
        assert_eq!(ev_rx.recv().await.unwrap(), SessionEvent::Output(b"live".to_vec()));
        assert_eq!(ev_rx.recv().await.unwrap(), SessionEvent::Ended("exited(0)".into()));

        driver.await.unwrap().unwrap();
        host.await.unwrap();
    }

    #[tokio::test]
    async fn drive_creates_before_attaching_when_asked() {
        let (client, mut server) = duplex(4096);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            match read_frame(&mut server).await.unwrap() {
                Frame::Create { session, project, room, .. } => {
                    assert_eq!(session, "fresh");
                    assert_eq!(project, "acme");
                    assert_eq!(room, "design-talk");
                }
                other => panic!("expected Create, got {other:?}"),
            }
            write_frame(&mut server, &Frame::Ok).await.unwrap();
            assert!(matches!(read_frame(&mut server).await.unwrap(), Frame::Attach { .. }));
            write_frame(&mut server, &Frame::Ok).await.unwrap();
            write_frame(&mut server, &Frame::SessionEnded("done".into())).await.unwrap();
        });

        let (_cmd_tx, cmd_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        drive(
            client,
            AttachRequest {
                token: "".into(),
                session: "fresh".into(),
                write: true,
                create: Some(CreateSpec { command: vec!["bash".into()], cwd: "/home/dev".into(), project: "acme".into(), room: "design-talk".into(), cols: 80, rows: 24 }),
            },
            cmd_rx,
            move |ev| { let _ = ev_tx.send(ev); },
        )
        .await
        .unwrap();
        assert_eq!(ev_rx.recv().await.unwrap(), SessionEvent::Ended("done".into()));
        host.await.unwrap();
    }

    #[tokio::test]
    async fn drive_detaches_on_command_leaving_the_session_alive() {
        let (client, mut server) = duplex(1024);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            read_frame(&mut server).await.unwrap(); // Attach
            write_frame(&mut server, &Frame::Ok).await.unwrap();
            // The detach reaches the host as a Detach frame — the session is not ended.
            assert_eq!(read_frame(&mut server).await.unwrap(), Frame::Detach);
        });

        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let driver = tokio::spawn(async move {
            drive(
                client,
                AttachRequest { token: "".into(), session: "s".into(), write: false, create: None },
                cmd_rx,
                |_ev| {},
            )
            .await
        });
        cmd_tx.send(SessionCmd::Detach).await.unwrap();
        driver.await.unwrap().unwrap();
        host.await.unwrap();
    }

    /// A close that lands mid-prologue (the pane unmounted while the host was still answering):
    /// the Detach queued before the attach ack is honored the moment the ack arrives, so no
    /// attachment outlives its pane.
    #[tokio::test]
    async fn a_detach_queued_during_the_prologue_is_honored_right_after_the_attach_ack() {
        let (client, mut server) = duplex(1024);
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            read_frame(&mut server).await.unwrap(); // Attach
            closed_rx.await.unwrap();
            write_frame(&mut server, &Frame::Ok).await.unwrap();
            assert_eq!(read_frame(&mut server).await.unwrap(), Frame::Detach);
        });

        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let driver = tokio::spawn(async move {
            drive(
                client,
                AttachRequest { token: "".into(), session: "s".into(), write: false, create: None },
                cmd_rx,
                |_ev| {},
            )
            .await
        });
        cmd_tx.send(SessionCmd::Detach).await.unwrap();
        drop(cmd_tx);
        closed_tx.send(()).unwrap();
        driver.await.unwrap().unwrap();
        host.await.unwrap();
    }

    #[tokio::test]
    async fn attach_resolves_only_on_the_hosts_attach_ack_and_surfaces_a_refusal() {
        let (client, mut server) = duplex(1024);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            assert!(matches!(read_frame(&mut server).await.unwrap(), Frame::Attach { .. }));
            write_frame(&mut server, &Frame::Err("no session 's'".into())).await.unwrap();
        });
        let err = attach(
            client,
            &AttachRequest { token: "t".into(), session: "s".into(), write: true, create: None },
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(err.to_string().contains("no session 's'"), "{err}");
        host.await.unwrap();

        let (client, mut server) = duplex(1024);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            assert!(matches!(read_frame(&mut server).await.unwrap(), Frame::Attach { .. }));
            write_frame(&mut server, &Frame::Ok).await.unwrap();
        });
        attach(
            client,
            &AttachRequest { token: "t".into(), session: "s".into(), write: true, create: None },
        )
        .await
        .unwrap();
        host.await.unwrap();
    }

    #[tokio::test]
    async fn a_refused_hello_surfaces_the_hosts_message() {
        let (client, mut server) = duplex(1024);
        let host = tokio::spawn(async move {
            handshake(&mut server).await.unwrap();
            read_frame(&mut server).await.unwrap(); // Hello
            write_frame(&mut server, &Frame::Err("token is not valid or has expired".into())).await.unwrap();
        });
        let (_cmd_tx, cmd_rx) = mpsc::channel(1);
        let err = drive(
            client,
            AttachRequest { token: "bad".into(), session: "s".into(), write: true, create: None },
            cmd_rx,
            |_ev| {},
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("not valid"), "{err}");
        assert_eq!(
            err.kind(),
            io::ErrorKind::PermissionDenied,
            "a host refusal must be distinguishable from a transport failure"
        );
        host.await.unwrap();
    }

    #[tokio::test]
    async fn a_frame_split_around_an_interleaved_command_still_arrives_intact() {
        let (client, mut server) = duplex(64);
        let payload = vec![7u8; 200];
        let expected = payload.clone();
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            assert!(matches!(
                read_frame(&mut server).await.unwrap(),
                Frame::Attach { .. }
            ));
            write_frame(&mut server, &Frame::Ok).await.unwrap();
            write_frame(
                &mut server,
                &Frame::Output {
                    last_input_seq: 0,
                    bytes: payload,
                },
            )
            .await
            .unwrap();
            assert_eq!(
                read_frame(&mut server).await.unwrap(),
                Frame::Input {
                    seq: 1,
                    bytes: b"k".to_vec()
                },
                "the interleaved keystroke arrives intact, in order"
            );
            write_frame(&mut server, &Frame::SessionEnded("done".into()))
                .await
                .unwrap();
        });

        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let driver = tokio::spawn(async move {
            drive(
                client,
                AttachRequest {
                    token: "t".into(),
                    session: "s".into(),
                    write: true,
                    create: None,
                },
                cmd_rx,
                move |ev| {
                    let _ = ev_tx.send(ev);
                },
            )
            .await
        });

        cmd_tx.send(SessionCmd::Input(b"k".to_vec())).await.unwrap();

        let mut saw_full_output = false;
        loop {
            match ev_rx.recv().await.unwrap() {
                SessionEvent::Output(bytes) => {
                    assert_eq!(bytes, expected, "the big frame is reassembled, never desynced");
                    saw_full_output = true;
                }
                SessionEvent::Ended(reason) => {
                    assert_eq!(reason, "done");
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_full_output, "the fragmented output frame arrived");

        driver.await.unwrap().unwrap();
        host.await.unwrap();
    }

    #[tokio::test]
    async fn control_round_trips_a_kill_request() {
        let (client, mut server) = duplex(1024);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            assert_eq!(read_frame(&mut server).await.unwrap(), Frame::Kill("a".into()));
            write_frame(&mut server, &Frame::Ok).await.unwrap();
        });
        let reply = control(client, "tok", Frame::Kill("a".into())).await.unwrap();
        assert_eq!(reply, Frame::Ok);
        host.await.unwrap();
    }

    fn listed(name: &str) -> SessionInfo {
        SessionInfo {
            name: name.into(),
            live: true,
            attached: 1,
            writer_fde: "uday".into(),
            room: "design-talk".into(),
            command: vec!["bash".into(), "-l".into()],
        }
    }

    #[tokio::test]
    async fn list_sessions_drains_every_page_through_the_next_cursor() {
        let (client, mut server) = duplex(4096);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            assert_eq!(
                read_frame(&mut server).await.unwrap(),
                Frame::ListSessions { after: "".into(), limit: PAGE_LIMIT }
            );
            write_frame(&mut server, &Frame::Sessions { sessions: vec![listed("a")], next: "a".into() }).await.unwrap();
            assert_eq!(
                read_frame(&mut server).await.unwrap(),
                Frame::ListSessions { after: "a".into(), limit: PAGE_LIMIT }
            );
            write_frame(&mut server, &Frame::Sessions { sessions: vec![listed("b")], next: "".into() }).await.unwrap();
        });
        let listing = list_sessions(client, "tok").await.unwrap();
        assert_eq!(listing.sessions, vec![listed("a"), listed("b")]);
        assert_eq!(listing.host_boot_id, "boot-1", "the boot id the host welcomed us under rides the listing");
        host.await.unwrap();
    }

    #[tokio::test]
    async fn a_listing_cursor_that_never_advances_is_refused() {
        let (client, mut server) = duplex(4096);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            read_frame(&mut server).await.unwrap();
            write_frame(&mut server, &Frame::Sessions { sessions: vec![listed("a")], next: "a".into() }).await.unwrap();
            read_frame(&mut server).await.unwrap();
            write_frame(&mut server, &Frame::Sessions { sessions: vec![listed("a")], next: "a".into() }).await.unwrap();
        });
        let err = list_sessions(client, "tok").await.unwrap_err();
        assert!(err.to_string().contains("cursor went backwards"), "{err}");
        host.await.unwrap();
    }

    #[tokio::test]
    async fn a_listing_that_never_ends_is_refused_at_the_aggregate_bound() {
        let (client, mut server) = duplex(65536);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            let mut page: u32 = 0;
            loop {
                if read_frame(&mut server).await.is_err() {
                    break;
                }
                let sessions = (0..PAGE_LIMIT)
                    .map(|i| listed(&format!("s-{page:04}-{i:02}")))
                    .collect();
                page += 1;
                let reply = Frame::Sessions { sessions, next: format!("s-{page:04}") };
                if write_frame(&mut server, &reply).await.is_err() {
                    break;
                }
            }
        });
        let err = list_sessions(client, "tok").await.unwrap_err();
        assert!(err.to_string().contains("unbounded"), "{err}");
        host.abort();
    }

    #[tokio::test]
    async fn a_take_write_command_reaches_the_host_and_the_grant_comes_back_as_an_event() {
        let (client, mut server) = duplex(1024);
        let host = tokio::spawn(async move {
            host_handshake_hello(&mut server).await;
            read_frame(&mut server).await.unwrap(); // Attach
            write_frame(&mut server, &Frame::Ok).await.unwrap();
            assert_eq!(read_frame(&mut server).await.unwrap(), Frame::TakeWrite);
            write_frame(&mut server, &Frame::WriterChanged("uday".into())).await.unwrap();
            write_frame(&mut server, &Frame::SessionEnded("exited(0)".into())).await.unwrap();
        });

        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let driver = tokio::spawn(async move {
            drive(
                client,
                AttachRequest { token: "t".into(), session: "s".into(), write: false, create: None },
                cmd_rx,
                move |ev| { let _ = ev_tx.send(ev); },
            )
            .await
        });
        cmd_tx.send(SessionCmd::TakeWrite).await.unwrap();
        assert_eq!(ev_rx.recv().await.unwrap(), SessionEvent::WriterChanged("uday".into()));
        assert_eq!(ev_rx.recv().await.unwrap(), SessionEvent::Ended("exited(0)".into()));
        driver.await.unwrap().unwrap();
        host.await.unwrap();
    }
}
