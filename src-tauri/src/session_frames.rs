//! Framing for the session data channel toward the webview. Output bytes and the replay markers
//! ride ONE ordered raw channel — a mid-stream replay must reset the client terminal before the
//! snapshot bytes land — so every message is a tag byte followed by its payload. Byte-pinned
//! against `src/mainview/terminal/dataFrames.ts`.

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

#[cfg(test)]
mod tests {
    use super::*;

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
