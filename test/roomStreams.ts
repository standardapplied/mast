import type { RoomStreamHandle } from "../src/mainview/gateway";
import type { EventStreamState, SailEvent } from "../src/shared/sail-models";

/**
 * The gateway's room-stream lane for component tests, the one place a fake gateway gets
 * `openRoomStream` from. A test that drives a live turn pushes events and stream states into
 * the room it names; a fake that never does still hands the room a stream that stays silent.
 */
export function fakeRoomStreams() {
  type Stream = {
    roomId: string;
    events: Set<(event: SailEvent) => void>;
    states: Set<(state: EventStreamState) => void>;
  };
  const open = new Set<Stream>();
  const opened: string[] = [];
  const of = (roomId: string) => [...open].filter((stream) => stream.roomId === roomId);
  return {
    /** The room of every stream ever opened, in order. */
    opened,
    /** The rooms whose stream is open now. */
    open: () => [...open].map((stream) => stream.roomId),
    openRoomStream(roomId: string): RoomStreamHandle {
      const stream: Stream = { roomId, events: new Set(), states: new Set() };
      open.add(stream);
      opened.push(roomId);
      return {
        onEvent(listener) {
          stream.events.add(listener);
          return () => stream.events.delete(listener);
        },
        onState(listener) {
          stream.states.add(listener);
          return () => stream.states.delete(listener);
        },
        stop: () => void open.delete(stream),
      };
    },
    emit(roomId: string, event: SailEvent) {
      of(roomId).forEach((stream) => stream.events.forEach((listener) => listener(event)));
    },
    setState(roomId: string, state: EventStreamState) {
      of(roomId).forEach((stream) => stream.states.forEach((listener) => listener(state)));
    },
  };
}
