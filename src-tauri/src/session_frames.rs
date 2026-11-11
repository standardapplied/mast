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

/// Output leaves at once when none left in the last window, and otherwise waits until that window
/// closes, or until the batch holds [`COALESCE_CAP`] bytes. A lone keystroke's echo pays nothing;
/// a firehose still costs at most one message per window: every message costs an IPC hop and one
/// `vt_write` on the webview, so a firehose of small reads must not become a firehose of messages
/// that starves the frame loop.
pub const COALESCE_WINDOW: Duration = Duration::from_millis(16);
pub const COALESCE_CAP: usize = 256 * 1024;

/// One session's lane toward the webview, deciding on the clock it is handed: output is batched
/// per [`COALESCE_WINDOW`]/[`COALESCE_CAP`] into one frame (tag first, then the bytes in arrival
/// order); every other event flushes the batch ahead of itself and then travels as its own frame,
/// so nothing can overtake the bytes that preceded it.
#[derive(Default)]
struct Coalescer {
    frame: Vec<u8>,
    sent_at: Option<Instant>,
}

impl Coalescer {
    /// Takes `event` at `now`, sending whatever it releases in channel order.
    fn event(&mut self, event: SessionEvent, now: Instant, send: &mut impl FnMut(Vec<u8>)) {
        match event {
            SessionEvent::Output(bytes) => {
                self.hold(&bytes);
                if self.frame.len() > COALESCE_CAP || self.window_closed(now) {
                    self.flush(now, send);
                }
            }
            event => {
                self.flush(now, send);
                send(encode(&event));
            }
        }
    }

    /// When the held output falls due, a window after the last output left; `None` when nothing
    /// is held.
    fn due(&self) -> Option<Instant> {
        self.sent_at.filter(|_| !self.frame.is_empty()).map(|at| at + COALESCE_WINDOW)
    }

    /// Sends the held output, if any, as having left at `now`.
    fn flush(&mut self, now: Instant, send: &mut impl FnMut(Vec<u8>)) {
        if !self.frame.is_empty() {
            self.sent_at = Some(now);
            send(std::mem::take(&mut self.frame));
        }
    }

    fn window_closed(&self, now: Instant) -> bool {
        self.sent_at.map_or(true, |at| at + COALESCE_WINDOW <= now)
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

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn output(bytes: &[u8]) -> SessionEvent {
        SessionEvent::Output(bytes.to_vec())
    }

    /// A coalescer on an injected clock, stepped the way [`pump`] steps it: held output leaves at
    /// its deadline once the clock passes it. Every frame is kept with the offset it left at.
    struct Clocked {
        start: Instant,
        lane: Coalescer,
        sent: Vec<(Duration, Vec<u8>)>,
    }

    impl Clocked {
        fn new() -> Self {
            Self { start: Instant::now(), lane: Coalescer::default(), sent: Vec::new() }
        }

        /// `event` arrives `at` after the start, behind every deadline that fell before it.
        fn at(&mut self, at: Duration, event: SessionEvent) {
            if let Some(due) = self.lane.due().filter(|due| *due <= self.start + at) {
                self.leave(due);
            }
            let sent = &mut self.sent;
            self.lane.event(event, self.start + at, &mut |frame| sent.push((at, frame)));
        }

        /// Nothing more arrives: the held output leaves at its deadline.
        fn settle(&mut self) -> &[(Duration, Vec<u8>)] {
            if let Some(due) = self.lane.due() {
                self.leave(due);
            }
            &self.sent
        }

        fn leave(&mut self, due: Instant) {
            let (left, sent) = (due - self.start, &mut self.sent);
            self.lane.flush(due, &mut |frame| sent.push((left, frame)));
        }
    }

    /// Outputs that arrive at their offsets, run to the end; the frames, with when each left.
    fn coalesced(arrivals: &[(Duration, Vec<u8>)]) -> Vec<(Duration, Vec<u8>)> {
        let mut clocked = Clocked::new();
        for (at, bytes) in arrivals {
            clocked.at(*at, output(bytes));
        }
        clocked.settle().to_vec()
    }

    /// Reads of `read` bytes at `rate` bytes per second for `span`; every byte tells its place.
    fn stream(rate: u64, read: usize, span: Duration) -> Vec<(Duration, Vec<u8>)> {
        let every = Duration::from_nanos(1_000_000_000 * read as u64 / rate);
        let mut place = 0usize;
        (0..)
            .map(|n| every * n)
            .take_while(|at| *at < span)
            .map(|at| {
                let bytes = (place..place + read).map(|i| i as u8).collect();
                place += read;
                (at, bytes)
            })
            .collect()
    }

    /// When each output byte arrived and when it left, in byte order, once every byte is shown to
    /// have left exactly once and in the order it arrived.
    fn journeys(arrivals: &[(Duration, Vec<u8>)], sent: &[(Duration, Vec<u8>)]) -> Vec<(Duration, Duration)> {
        let arrived: Vec<(Duration, u8)> =
            arrivals.iter().flat_map(|(at, bytes)| bytes.iter().map(move |b| (*at, *b))).collect();
        let left: Vec<(Duration, u8)> = sent
            .iter()
            .flat_map(|(at, frame)| {
                assert_eq!(frame[0], TAG_BYTES, "only output frames");
                frame[1..].iter().map(move |b| (*at, *b))
            })
            .collect();
        let content = |bytes: &[(Duration, u8)]| bytes.iter().map(|(_, b)| *b).collect::<Vec<_>>();
        assert_eq!(content(&arrived), content(&left), "every byte once, in order");
        arrived.iter().zip(&left).map(|((came, _), (went, _))| (*came, *went)).collect()
    }

    fn longest_wait(arrivals: &[(Duration, Vec<u8>)]) -> Duration {
        let sent = coalesced(arrivals);
        journeys(arrivals, &sent).into_iter().map(|(came, went)| went - came).max().unwrap()
    }

    /// What a frame says, one output byte at a time, so batching cannot hide in a comparison.
    fn spoken(frame: &[u8]) -> Vec<Vec<u8>> {
        if frame[0] == TAG_BYTES {
            frame[1..].iter().map(|b| vec![TAG_BYTES, *b]).collect()
        } else {
            vec![frame.to_vec()]
        }
    }

    /// A deterministic xorshift, so a failing seed replays.
    struct Rng(u64);

    impl Rng {
        fn below(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % n
        }
    }

    /// Random chunks (empty ones included) at random gaps: none, inside a window, exactly one,
    /// and well past it.
    fn random_arrivals(rng: &mut Rng) -> Vec<(Duration, Vec<u8>)> {
        let mut at = Duration::ZERO;
        let mut place = 0u8;
        (0..1 + rng.below(80))
            .map(|_| {
                at += match rng.below(4) {
                    0 => Duration::ZERO,
                    1 => Duration::from_micros(rng.below(16_000)),
                    2 => COALESCE_WINDOW,
                    _ => Duration::from_micros(16_000 + rng.below(50_000)),
                };
                let bytes = (0..rng.below(48))
                    .map(|_| {
                        place = place.wrapping_add(1);
                        place
                    })
                    .collect();
                (at, bytes)
            })
            .collect()
    }

    /// The client-added delay the core may impose before the webview hears output, in absolute
    /// terms so a retuned window fails here as well as a changed policy: nothing for a lone
    /// keystroke echo, and no more than 16 ms (about one 60 Hz frame) for any byte of a burst.
    const LONE_ECHO_BUDGET: Duration = Duration::ZERO;
    const BURST_BUDGET: Duration = Duration::from_millis(16);

    #[test]
    fn a_refusal_is_a_meta_frame_carrying_the_hosts_reason() {
        assert_eq!(
            encode(&SessionEvent::Refused("You do not hold the write token.".into())),
            tagged(TAG_META, r#"{"kind":"refused","reason":"You do not hold the write token."}"#)
        );
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

    #[test]
    fn a_lone_output_leaves_the_moment_it_arrives() {
        let mut clocked = Clocked::new();
        clocked.at(ms(100), output(b"x"));
        assert_eq!(clocked.sent, vec![(ms(100), b"\x00x".to_vec())]);
        assert_eq!(clocked.lane.due(), None, "nothing is held");
    }

    #[test]
    fn output_behind_a_delivery_waits_out_its_window_and_leaves_as_one_message() {
        let sent = coalesced(&[
            (ms(0), b"ab".to_vec()),
            (ms(3), b"c".to_vec()),
            (ms(5), b"".to_vec()),
            (ms(9), b"de".to_vec()),
        ]);
        assert_eq!(sent, vec![(ms(0), b"\x00ab".to_vec()), (COALESCE_WINDOW, b"\x00cde".to_vec())]);
    }

    #[test]
    fn an_empty_output_on_an_idle_lane_sends_and_holds_nothing() {
        let mut clocked = Clocked::new();
        clocked.at(ms(0), output(b""));
        assert_eq!(clocked.lane.due(), None);
        assert!(clocked.settle().is_empty());
    }

    #[test]
    fn a_stream_at_a_megabyte_a_second_is_at_most_one_message_per_window_every_byte_once_in_order() {
        let arrivals = stream(1_000_000, 4096, Duration::from_secs(1));
        let sent = coalesced(&arrivals);
        let windows = Duration::from_secs(1).as_micros().div_ceil(COALESCE_WINDOW.as_micros()) as usize;
        assert!(
            sent.len() <= windows + 1,
            "{} messages: more than one per window the stream spans and the one its tail waits out",
            sent.len()
        );
        for pair in sent.windows(2) {
            assert!(pair[1].0 - pair[0].0 >= COALESCE_WINDOW, "two messages inside one window");
        }
        let longest = longest_wait(&arrivals);
        assert!(longest <= COALESCE_WINDOW, "a byte waited {longest:?}");
    }

    #[test]
    fn after_a_burst_one_more_byte_past_an_idle_gap_leaves_at_once() {
        let mut arrivals = stream(1_000_000, 512, ms(200));
        let gap = arrivals.last().unwrap().0 + COALESCE_WINDOW * 3;
        arrivals.push((gap, b"$".to_vec()));
        let sent = coalesced(&arrivals);
        assert_eq!(sent.last().unwrap(), &(gap, b"\x00$".to_vec()));
    }

    #[test]
    fn the_cap_closes_a_batch_without_waiting_for_the_window() {
        let half = vec![7u8; COALESCE_CAP / 2 + 1];
        let sent = coalesced(&[
            (ms(0), b"x".to_vec()),
            (ms(1), half.clone()),
            (ms(2), half.clone()),
            (ms(3), b"next".to_vec()),
        ]);
        let left: Vec<(Duration, usize)> = sent.iter().map(|(at, frame)| (*at, frame.len())).collect();
        assert_eq!(
            left,
            vec![(ms(0), 2), (ms(2), 1 + half.len() * 2), (ms(2) + COALESCE_WINDOW, 5)],
            "the two halves close one batch at the cap; what follows waits out the window from there"
        );
    }

    #[test]
    fn a_replay_arriving_as_one_large_batch_leaves_whole_between_its_markers() {
        let snapshot: Vec<u8> = (0..4 * 1024 * 1024).map(|i| i as u8).collect();
        let mut clocked = Clocked::new();
        clocked.at(ms(0), output(b"live"));
        clocked.at(ms(1), SessionEvent::Replaying { safe: true });
        clocked.at(ms(1), SessionEvent::Output(snapshot.clone()));
        clocked.at(ms(1), SessionEvent::ReplayDone);
        let frames: Vec<Vec<u8>> = clocked.settle().iter().map(|(_, frame)| frame.clone()).collect();
        assert_eq!(
            frames,
            vec![
                b"\x00live".to_vec(),
                vec![TAG_REPLAY_BEGIN, 1],
                [&[TAG_BYTES][..], &snapshot].concat(),
                vec![TAG_REPLAY_END],
            ]
        );
    }

    #[test]
    fn any_chunking_at_any_timing_leaves_idle_output_at_once_and_holds_none_past_a_window() {
        for seed in 1..=500u64 {
            let arrivals = random_arrivals(&mut Rng(seed));
            let sent = coalesced(&arrivals);
            for pair in sent.windows(2) {
                assert!(pair[1].0 - pair[0].0 >= COALESCE_WINDOW, "seed {seed}: two messages inside one window");
            }
            let trips = journeys(&arrivals, &sent);
            assert!(
                trips.iter().all(|(came, went)| *went - *came <= COALESCE_WINDOW),
                "seed {seed}: a byte waited past the window"
            );
            let mut place = 0;
            for (at, bytes) in &arrivals {
                let idle = trips[..place].iter().all(|(_, went)| *went + COALESCE_WINDOW <= *at);
                if idle && !bytes.is_empty() {
                    assert_eq!(trips[place].1, *at, "seed {seed}: output on an idle lane was held");
                }
                place += bytes.len();
            }
        }
    }

    #[test]
    fn whatever_the_timing_the_channel_says_everything_once_in_the_order_it_happened() {
        for seed in 1..=500u64 {
            let mut rng = Rng(seed);
            let mut clocked = Clocked::new();
            let mut said = Vec::new();
            for (n, (at, bytes)) in random_arrivals(&mut rng).into_iter().enumerate() {
                let event = match rng.below(5) {
                    0 => SessionEvent::Resized { cols: n as u32, rows: 24 },
                    _ => SessionEvent::Output(bytes),
                };
                if event != SessionEvent::Output(Vec::new()) {
                    said.extend(spoken(&encode(&event)));
                }
                clocked.at(at, event);
            }
            let heard: Vec<Vec<u8>> = clocked.settle().iter().flat_map(|(_, frame)| spoken(frame)).collect();
            assert_eq!(heard, said, "seed {seed}");
        }
    }

    #[test]
    fn the_budget_a_lone_echo_waits_nothing_and_no_byte_of_a_burst_waits_past_a_frame() {
        let typed: Vec<(Duration, Vec<u8>)> = (0..20).map(|n| (ms(120) * n, b"k".to_vec())).collect();
        let lone = longest_wait(&typed);
        assert!(lone <= LONE_ECHO_BUDGET, "a lone echo waited {lone:?} in the core");
        let burst = longest_wait(&stream(1_000_000, 4096, Duration::from_secs(1)));
        assert!(burst <= BURST_BUDGET, "a burst byte waited {burst:?} in the core");
    }

    #[tokio::test]
    async fn the_pump_sends_held_output_once_its_window_closes_with_nothing_else_arriving() {
        let (ev_tx, mut out, _task) = pumping();
        ev_tx.send(output(b"a")).unwrap();
        ev_tx.send(output(b"b")).unwrap();
        assert_eq!(out.recv().await.unwrap(), b"\x00a".to_vec());
        assert_eq!(out.recv().await.unwrap(), b"\x00b".to_vec());
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
