//! Framing for the session data channel toward the webview. Output bytes and the replay markers
//! ride ONE ordered raw channel — a mid-stream replay must reset the client terminal before the
//! snapshot bytes land — so every message is a tag byte followed by its payload. Byte-pinned
//! against `src/mainview/terminal/dataFrames.ts`.

use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::{sleep_until, Instant};

use crate::pty::SessionEvent;

const TAG_BYTES: u8 = 0;
const TAG_REPLAY_BEGIN: u8 = 1;
const TAG_REPLAY_END: u8 = 2;

/// The data-channel frame for `event`, or `None` for events that travel on the meta/exit lanes.
pub fn encode(event: &SessionEvent) -> Option<Vec<u8>> {
    match event {
        SessionEvent::Output(bytes) => {
            let mut frame = Vec::with_capacity(bytes.len() + 1);
            frame.push(TAG_BYTES);
            frame.extend_from_slice(bytes);
            Some(frame)
        }
        SessionEvent::Replaying { safe } => Some(vec![TAG_REPLAY_BEGIN, u8::from(*safe)]),
        SessionEvent::ReplayDone => Some(vec![TAG_REPLAY_END]),
        _ => None,
    }
}

/// Output is coalesced per session into one message per window, or sooner once a batch holds
/// [`COALESCE_CAP`] bytes: every message costs an IPC hop and one `vt_write` on the webview, so a
/// firehose of small reads must not become a firehose of messages that starves the frame loop.
pub const COALESCE_WINDOW: Duration = Duration::from_millis(16);
pub const COALESCE_CAP: usize = 256 * 1024;

/// Output bytes gathered into one data-channel frame (tag first, then the bytes in arrival order).
#[derive(Default)]
pub struct OutputBatch {
    frame: Vec<u8>,
}

impl OutputBatch {
    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if self.frame.is_empty() {
            self.frame.reserve(bytes.len() + 1);
            self.frame.push(TAG_BYTES);
        }
        self.frame.extend_from_slice(bytes);
    }

    pub fn is_full(&self) -> bool {
        self.frame.len() > COALESCE_CAP
    }

    /// The pending frame, leaving the batch empty; `None` when nothing was gathered.
    pub fn take(&mut self) -> Option<Vec<u8>> {
        if self.frame.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.frame))
        }
    }
}

/// Drains one session's events toward the webview until the sender side is dropped. Output is
/// batched per [`COALESCE_WINDOW`]/[`COALESCE_CAP`] into `data`; every other event flushes the
/// batch ahead of itself, then travels as its own data frame (the replay markers) or goes to
/// `other` (endings, meta), so nothing can overtake the bytes that preceded it. The final batch
/// is flushed before returning.
pub async fn pump<D, E>(mut events: mpsc::UnboundedReceiver<SessionEvent>, mut data: D, mut other: E)
where
    D: FnMut(Vec<u8>),
    E: FnMut(SessionEvent),
{
    let mut batch = OutputBatch::default();
    let mut deadline: Option<Instant> = None;
    loop {
        tokio::select! {
            event = events.recv() => match event {
                None => {
                    if let Some(frame) = batch.take() {
                        data(frame);
                    }
                    return;
                }
                Some(SessionEvent::Output(bytes)) => {
                    batch.push(&bytes);
                    if batch.is_full() {
                        if let Some(frame) = batch.take() {
                            data(frame);
                        }
                        deadline = None;
                    } else if deadline.is_none() {
                        deadline = Some(Instant::now() + COALESCE_WINDOW);
                    }
                }
                Some(event) => {
                    if let Some(frame) = batch.take() {
                        data(frame);
                    }
                    deadline = None;
                    match encode(&event) {
                        Some(frame) => data(frame),
                        None => other(event),
                    }
                }
            },
            _ = sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                if let Some(frame) = batch.take() {
                    data(frame);
                }
                deadline = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    enum Sent {
        Data(Vec<u8>),
        Other(SessionEvent),
    }

    /// A running pump whose every delivery lands, in order, on one channel.
    fn pumping() -> (mpsc::UnboundedSender<SessionEvent>, mpsc::UnboundedReceiver<Sent>, tokio::task::JoinHandle<()>) {
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let data_tx = out_tx.clone();
        let task = tokio::spawn(pump(
            ev_rx,
            move |frame| {
                let _ = data_tx.send(Sent::Data(frame));
            },
            move |event| {
                let _ = out_tx.send(Sent::Other(event));
            },
        ));
        (ev_tx, out_rx, task)
    }

    #[tokio::test]
    async fn outputs_within_a_window_become_one_message() {
        let (ev_tx, mut out, task) = pumping();
        for chunk in [&b"ab"[..], b"c", b"", b"de"] {
            ev_tx.send(SessionEvent::Output(chunk.to_vec())).unwrap();
        }
        assert_eq!(out.recv().await.unwrap(), Sent::Data(b"\x00abcde".to_vec()));
        drop(ev_tx);
        task.await.unwrap();
        assert!(out.recv().await.is_none(), "nothing is sent twice");
    }

    #[tokio::test]
    async fn a_marker_or_ending_flushes_the_batch_ahead_of_itself() {
        let (ev_tx, mut out, task) = pumping();
        ev_tx.send(SessionEvent::Output(b"before".to_vec())).unwrap();
        ev_tx.send(SessionEvent::Replaying { safe: true }).unwrap();
        ev_tx.send(SessionEvent::Output(b"snapshot".to_vec())).unwrap();
        ev_tx.send(SessionEvent::ReplayDone).unwrap();
        ev_tx.send(SessionEvent::Resized { cols: 100, rows: 30 }).unwrap();
        ev_tx.send(SessionEvent::Output(b"tail".to_vec())).unwrap();
        ev_tx.send(SessionEvent::Ended("exited(0)".into())).unwrap();
        drop(ev_tx);
        task.await.unwrap();
        let mut sent = Vec::new();
        while let Some(s) = out.recv().await {
            sent.push(s);
        }
        assert_eq!(
            sent,
            vec![
                Sent::Data(b"\x00before".to_vec()),
                Sent::Data(vec![TAG_REPLAY_BEGIN, 1]),
                Sent::Data(b"\x00snapshot".to_vec()),
                Sent::Data(vec![TAG_REPLAY_END]),
                Sent::Other(SessionEvent::Resized { cols: 100, rows: 30 }),
                Sent::Data(b"\x00tail".to_vec()),
                Sent::Other(SessionEvent::Ended("exited(0)".into())),
            ]
        );
    }

    #[tokio::test]
    async fn the_cap_closes_a_batch_without_waiting_for_the_window() {
        let (ev_tx, mut out, task) = pumping();
        let half = vec![7u8; COALESCE_CAP / 2 + 1];
        ev_tx.send(SessionEvent::Output(half.clone())).unwrap();
        ev_tx.send(SessionEvent::Output(half.clone())).unwrap();
        ev_tx.send(SessionEvent::Output(b"next".to_vec())).unwrap();
        let first = out.recv().await.unwrap();
        let Sent::Data(frame) = first else { panic!("expected data, got {first:?}") };
        assert_eq!(frame.len(), 1 + half.len() * 2, "the two halves close one batch at the cap");
        assert_eq!(out.recv().await.unwrap(), Sent::Data(b"\x00next".to_vec()));
        drop(ev_tx);
        task.await.unwrap();
    }

    #[test]
    fn an_empty_batch_has_nothing_to_take() {
        let mut batch = OutputBatch::default();
        batch.push(b"");
        assert_eq!(batch.take(), None);
        batch.push(b"x");
        assert_eq!(batch.take(), Some(vec![TAG_BYTES, b'x']));
        assert_eq!(batch.take(), None);
    }

    #[test]
    fn output_is_tag_zero_then_the_bytes_verbatim() {
        let frame = encode(&SessionEvent::Output(vec![0x1b, 0x5b, 0x48, 0x00, 0xff])).unwrap();
        assert_eq!(frame, vec![0, 0x1b, 0x5b, 0x48, 0x00, 0xff]);
        assert_eq!(encode(&SessionEvent::Output(vec![])).unwrap(), vec![0]);
    }

    #[test]
    fn replay_markers_are_tags_one_and_two() {
        assert_eq!(encode(&SessionEvent::Replaying { safe: true }).unwrap(), vec![1, 1]);
        assert_eq!(encode(&SessionEvent::Replaying { safe: false }).unwrap(), vec![1, 0]);
        assert_eq!(encode(&SessionEvent::ReplayDone).unwrap(), vec![2]);
    }

    #[test]
    fn other_events_do_not_travel_on_the_data_channel() {
        assert_eq!(encode(&SessionEvent::Paused), None);
        assert_eq!(encode(&SessionEvent::Continued), None);
        assert_eq!(encode(&SessionEvent::WriterChanged("uday".into())), None);
        assert_eq!(encode(&SessionEvent::Resized { cols: 80, rows: 24 }), None);
        assert_eq!(encode(&SessionEvent::Ended("exited(0)".into())), None);
    }
}
