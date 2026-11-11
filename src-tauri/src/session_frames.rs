//! Framing for the session channel toward the webview. Everything a session says — output bytes,
//! the replay markers, state changes, and the ending — rides ONE ordered raw channel, so every
//! message is a tag byte followed by its payload. Only one channel can hold the order: a Tauri
//! event runs on its own lane and overtakes a large raw frame still in flight (a resize would
//! then re-parse the bytes emitted before it at the new geometry), and a mid-stream replay must
//! reset the client terminal before the snapshot bytes land. Byte-pinned against
//! `src/mainview/terminal/dataFrames.ts`.

use std::time::Duration;

use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::{sleep_until, Instant};

use crate::pty::SessionEvent;

const TAG_BYTES: u8 = 0;
const TAG_REPLAY_BEGIN: u8 = 1;
const TAG_REPLAY_END: u8 = 2;
/// A state change as JSON: `{kind: writer_changed|resized|paused|continued|refused, ...}`.
const TAG_META: u8 = 3;
/// The ending as JSON: `{class, reason}`, the same shape a failed open rejects with.
const TAG_EXIT: u8 = 4;

/// The channel frame for `event`.
pub fn encode(event: &SessionEvent) -> Vec<u8> {
    match event {
        SessionEvent::Output(bytes) => {
            let mut frame = Vec::with_capacity(bytes.len() + 1);
            frame.push(TAG_BYTES);
            frame.extend_from_slice(bytes);
            frame
        }
        SessionEvent::Replaying { safe } => vec![TAG_REPLAY_BEGIN, u8::from(*safe)],
        SessionEvent::ReplayDone => vec![TAG_REPLAY_END],
        SessionEvent::Paused => json_frame(TAG_META, json!({ "kind": "paused" })),
        SessionEvent::Continued => json_frame(TAG_META, json!({ "kind": "continued" })),
        SessionEvent::WriterChanged(fde) => {
            json_frame(TAG_META, json!({ "kind": "writer_changed", "fde": fde }))
        }
        SessionEvent::Resized { cols, rows } => {
            json_frame(TAG_META, json!({ "kind": "resized", "cols": cols, "rows": rows }))
        }
        SessionEvent::Refused(reason) => {
            json_frame(TAG_META, json!({ "kind": "refused", "reason": reason }))
        }
        SessionEvent::Ended(reason) => exit("ended", reason),
    }
}

/// The ending frame: `class` reads as [`crate::ssh::end_class`] does, `reason` verbatim.
pub fn exit(class: &str, reason: &str) -> Vec<u8> {
    json_frame(TAG_EXIT, json!({ "class": class, "reason": reason }))
}

fn json_frame(tag: u8, payload: serde_json::Value) -> Vec<u8> {
    let mut frame = vec![tag];
    frame.extend_from_slice(payload.to_string().as_bytes());
    frame
}

/// Output is coalesced per session into one message per window, or sooner once a batch holds
/// [`COALESCE_CAP`] bytes: every message costs an IPC hop and one `vt_write` on the webview, so a
/// firehose of small reads must not become a firehose of messages that starves the frame loop.
pub const COALESCE_WINDOW: Duration = Duration::from_millis(16);
pub const COALESCE_CAP: usize = 256 * 1024;

/// One session's lane toward the webview, deciding on the clock it is handed: output is batched
/// per [`COALESCE_WINDOW`]/[`COALESCE_CAP`] into one frame (tag first, then the bytes in arrival
/// order); every other event flushes the batch ahead of itself and then travels as its own frame,
/// so nothing can overtake the bytes that preceded it.
#[derive(Default)]
pub struct Coalescer {
    frame: Vec<u8>,
    opened_at: Option<Instant>,
}

impl Coalescer {
    /// Takes `event` at `now`, sending whatever it releases in channel order.
    pub fn event(&mut self, event: SessionEvent, now: Instant, send: &mut impl FnMut(Vec<u8>)) {
        match event {
            SessionEvent::Output(bytes) => {
                self.hold(&bytes);
                if self.frame.len() > COALESCE_CAP {
                    self.flush(now, send);
                } else if self.opened_at.is_none() && !self.frame.is_empty() {
                    self.opened_at = Some(now);
                }
            }
            event => {
                self.flush(now, send);
                send(encode(&event));
            }
        }
    }

    /// When the held output falls due; `None` when nothing is held.
    pub fn due(&self) -> Option<Instant> {
        self.opened_at.map(|at| at + COALESCE_WINDOW)
    }

    /// Sends the held output, if any.
    pub fn flush(&mut self, _now: Instant, send: &mut impl FnMut(Vec<u8>)) {
        self.opened_at = None;
        if !self.frame.is_empty() {
            send(std::mem::take(&mut self.frame));
        }
    }

    fn hold(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if self.frame.is_empty() {
            self.frame.reserve(bytes.len() + 1);
            self.frame.push(TAG_BYTES);
        }
        self.frame.extend_from_slice(bytes);
    }
}

/// Drains one session's events toward the webview until the sender side is dropped, through a
/// [`Coalescer`] on the real clock. The final batch is flushed before returning.
pub async fn pump<S>(mut events: mpsc::UnboundedReceiver<SessionEvent>, mut send: S)
where
    S: FnMut(Vec<u8>),
{
    let mut lane = Coalescer::default();
    loop {
        let due = lane.due();
        tokio::select! {
            event = events.recv() => match event {
                Some(event) => lane.event(event, Instant::now(), &mut send),
                None => return lane.flush(Instant::now(), &mut send),
            },
            _ = sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                lane.flush(Instant::now(), &mut send);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A running pump whose every frame lands, in order, on one channel.
    fn pumping() -> (mpsc::UnboundedSender<SessionEvent>, mpsc::UnboundedReceiver<Vec<u8>>, tokio::task::JoinHandle<()>) {
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(pump(ev_rx, move |frame| {
            let _ = out_tx.send(frame);
        }));
        (ev_tx, out_rx, task)
    }

    fn tagged(tag: u8, json: &str) -> Vec<u8> {
        let mut frame = vec![tag];
        frame.extend_from_slice(json.as_bytes());
        frame
    }

    #[test]
    fn a_refusal_is_a_meta_frame_carrying_the_hosts_reason() {
        assert_eq!(
            encode(&SessionEvent::Refused("You do not hold the write token.".into())),
            tagged(TAG_META, r#"{"kind":"refused","reason":"You do not hold the write token."}"#)
        );
    }

    #[tokio::test]
    async fn outputs_within_a_window_become_one_message() {
        let (ev_tx, mut out, task) = pumping();
        for chunk in [&b"ab"[..], b"c", b"", b"de"] {
            ev_tx.send(SessionEvent::Output(chunk.to_vec())).unwrap();
        }
        assert_eq!(out.recv().await.unwrap(), b"\x00abcde".to_vec());
        drop(ev_tx);
        task.await.unwrap();
        assert!(out.recv().await.is_none(), "nothing is sent twice");
    }

    #[tokio::test]
    async fn every_other_event_flushes_the_batch_ahead_of_itself_on_the_same_channel() {
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
                b"\x00before".to_vec(),
                vec![TAG_REPLAY_BEGIN, 1],
                b"\x00snapshot".to_vec(),
                vec![TAG_REPLAY_END],
                tagged(TAG_META, r#"{"cols":100,"kind":"resized","rows":30}"#),
                b"\x00tail".to_vec(),
                tagged(TAG_EXIT, r#"{"class":"ended","reason":"exited(0)"}"#),
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
        let frame = out.recv().await.unwrap();
        assert_eq!(frame.len(), 1 + half.len() * 2, "the two halves close one batch at the cap");
        assert_eq!(out.recv().await.unwrap(), b"\x00next".to_vec());
        drop(ev_tx);
        task.await.unwrap();
    }

    #[test]
    fn an_empty_output_holds_nothing() {
        let mut lane = Coalescer::default();
        let mut sent = Vec::new();
        lane.event(SessionEvent::Output(Vec::new()), Instant::now(), &mut |frame| sent.push(frame));
        assert_eq!(lane.due(), None);
        lane.flush(Instant::now(), &mut |frame| sent.push(frame));
        assert!(sent.is_empty());
    }

    #[test]
    fn output_is_tag_zero_then_the_bytes_verbatim() {
        let frame = encode(&SessionEvent::Output(vec![0x1b, 0x5b, 0x48, 0x00, 0xff]));
        assert_eq!(frame, vec![0, 0x1b, 0x5b, 0x48, 0x00, 0xff]);
        assert_eq!(encode(&SessionEvent::Output(vec![])), vec![0]);
    }

    #[test]
    fn replay_markers_are_tags_one_and_two() {
        assert_eq!(encode(&SessionEvent::Replaying { safe: true }), vec![1, 1]);
        assert_eq!(encode(&SessionEvent::Replaying { safe: false }), vec![1, 0]);
        assert_eq!(encode(&SessionEvent::ReplayDone), vec![2]);
    }

    #[test]
    fn state_changes_are_tag_three_json() {
        assert_eq!(encode(&SessionEvent::Paused), tagged(3, r#"{"kind":"paused"}"#));
        assert_eq!(encode(&SessionEvent::Continued), tagged(3, r#"{"kind":"continued"}"#));
        assert_eq!(
            encode(&SessionEvent::WriterChanged("uday".into())),
            tagged(3, r#"{"fde":"uday","kind":"writer_changed"}"#)
        );
        assert_eq!(
            encode(&SessionEvent::Resized { cols: 80, rows: 24 }),
            tagged(3, r#"{"cols":80,"kind":"resized","rows":24}"#)
        );
    }

    #[test]
    fn endings_are_tag_four_json_in_the_shape_a_failed_open_rejects_with() {
        assert_eq!(
            encode(&SessionEvent::Ended("exited(0)".into())),
            tagged(4, r#"{"class":"ended","reason":"exited(0)"}"#)
        );
        assert_eq!(
            exit("transport", "connection reset"),
            tagged(4, r#"{"class":"transport","reason":"connection reset"}"#)
        );
    }
}
