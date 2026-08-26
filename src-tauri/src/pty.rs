//! Wire framing for the sail pty session host protocol, byte-compatible with the
//! Java `ai.singlr.sail.pty.PtyWire`: an 8-byte magic handshake, then
//! length-prefixed frames (`i32` length, `u8` type, payload). Integers are
//! big-endian; strings and byte blobs are an `i32` length followed by the raw
//! bytes. This module is pure framing — the async transport that carries it over
//! an SSH direct-streamlocal channel lives with the terminal backend.

#![allow(dead_code)]

/// Handshake magic; each peer writes it and must read the other's back.
pub const MAGIC: &[u8; 8] = b"SAILPTY1";

/// Frames larger than this are a protocol violation, refused rather than trusted.
pub const MAX_FRAME: usize = 1 << 20;

/// One session as the host lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub name: String,
    pub live: bool,
    pub attached: u32,
    pub writer_fde: String,
}

/// A protocol frame in either direction. The client sends the request forms and
/// receives the notification forms; both are modeled so the codec round-trips.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Hello(String),
    Create {
        session: String,
        command: Vec<String>,
        cwd: String,
        project: String,
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
    ListSessions,
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
    Sessions(Vec<SessionInfo>),
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
            cols,
            rows,
        } => {
            p.push(1);
            put_str(&mut p, session);
            put_i32(&mut p, command.len() as i32);
            for arg in command {
                put_str(&mut p, arg);
            }
            put_str(&mut p, cwd);
            put_str(&mut p, project);
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
        Frame::ListSessions => p.push(7),
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
        Frame::Sessions(list) => {
            p.push(29);
            put_i32(&mut p, list.len() as i32);
            for info in list {
                put_info(&mut p, info);
            }
        }
        Frame::Ok => p.push(30),
        Frame::Err(message) => {
            p.push(31);
            put_str(&mut p, message);
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
        1 => {
            let session = c.string()?;
            let count = c.i32()?;
            let mut command = Vec::with_capacity(count.max(0) as usize);
            for _ in 0..count {
                command.push(c.string()?);
            }
            Frame::Create {
                session,
                command,
                cwd: c.string()?,
                project: c.string()?,
                cols: c.i32()? as u32,
                rows: c.i32()? as u32,
            }
        }
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
        7 => Frame::ListSessions,
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
            let mut list = Vec::with_capacity(count.max(0) as usize);
            for _ in 0..count {
                list.push(c.info()?);
            }
            Frame::Sessions(list)
        }
        30 => Frame::Ok,
        31 => Frame::Err(c.string()?),
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

fn put_info(buf: &mut Vec<u8>, info: &SessionInfo) {
    put_str(buf, &info.name);
    buf.push(if info.live { 1 } else { 0 });
    put_i32(buf, info.attached as i32);
    put_str(buf, &info.writer_fde);
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

    fn info(&mut self) -> Result<SessionInfo, DecodeError> {
        Ok(SessionInfo {
            name: self.string()?,
            live: self.u8()? == 1,
            attached: self.i32()? as u32,
            writer_fde: self.string()?,
        })
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
        roundtrip(Frame::ListSessions);
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
        roundtrip(Frame::Sessions(vec![
            SessionInfo {
                name: "a".into(),
                live: true,
                attached: 2,
                writer_fde: "uday".into(),
            },
            SessionInfo {
                name: "b".into(),
                live: false,
                attached: 0,
                writer_fde: String::new(),
            },
        ]));
        roundtrip(Frame::Ok);
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
