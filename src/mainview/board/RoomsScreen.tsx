import { useEffect, useMemo, useState } from "react";
import { LoadingMark } from "../components/Loading";
import { Splitter } from "../components/Splitter";
import { useToast } from "../components/Toast";
import { Button, Eyebrow } from "../components/ui";
import type { Gateway } from "../gateway";
import { RoomList } from "./RoomList";
import { SpecDetail } from "./SpecDetail";
import {
  selectedRoom,
  visibleRooms,
  type RoomView,
  type StorageLike,
} from "./rooms";
import { useRooms } from "./useRooms";

const SIDEBAR_KEY = "mast.rooms.sidebar.width";
const ARCHIVE_KEY = "mast.rooms.archive.open";

function storedWidth(storage: StorageLike): number {
  const parsed = Number(storage.getItem(SIDEBAR_KEY));
  return Number.isFinite(parsed) && parsed >= 240 && parsed <= 460 ? parsed : 320;
}

export function RoomsScreen({
  gateway,
  storage = localStorage,
  onFocus,
}: {
  gateway: Gateway;
  storage?: StorageLike;
  /** Reports the focused room's spec id so app-level notifications can suppress it. */
  onFocus?: (specId: string | null) => void;
}) {
  const { data, open, create } = useRooms(gateway, storage);
  const [project, setProject] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [showArchive, setShowArchive] = useState(() => storage.getItem(ARCHIVE_KEY) === "true");
  const [creating, setCreating] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => storedWidth(storage));
  const { showToast } = useToast();

  useEffect(() => {
    if (project || data.rooms.length === 0) return;
    setProject(data.rooms[0]!.spec.project);
  }, [data.rooms, project]);

  useEffect(() => {
    if (!project && data.rooms.length === 0 && data.projects.length > 0) {
      setProject(data.projects[0]!);
    }
  }, [data.projects, data.rooms.length, project]);

  const projectRooms = useMemo(
    () => data.rooms.filter((room) => room.spec.project === project),
    [data.rooms, project],
  );
  const shownRooms = useMemo(
    () => visibleRooms(projectRooms, showArchive),
    [projectRooms, showArchive],
  );

  useEffect(() => {
    const current = projectRooms.find((room) => room.spec.id === selectedId);
    if (current) {
      if (current.unread) open(current);
      return;
    }
    // Remembered selections are honored only within the active filter — a room
    // that has since been archived must not drag the archive into view.
    const remembered = selectedRoom(storage, project);
    const next = shownRooms.find((room) => room.spec.id === remembered) ?? shownRooms[0];
    setSelectedId(next?.spec.id);
    if (next) open(next);
  }, [open, project, projectRooms, selectedId, shownRooms, storage]);

  const select = (room: RoomView) => {
    setSelectedId(room.spec.id);
    open(room);
  };

  const createRoom = async (title: string, targetProject: string, agent?: string) => {
    setCreating(true);
    const result = await create(title, targetProject, agent);
    setCreating(false);
    if (!result.ok) {
      showToast("error", result.error.message);
      return false;
    }
    setProject(result.value.spec.project);
    setSelectedId(result.value.spec.id);
    if ("engageError" in result && result.engageError) {
      showToast("error", `Created ${result.value.spec.id}, but the agent could not join: ${result.engageError}`);
    } else {
      showToast("success", `Created ${result.value.spec.id}.`);
    }
    return true;
  };

  const selected = data.rooms.find((room) => room.spec.id === selectedId);

  useEffect(() => {
    onFocus?.(selectedId ?? null);
  }, [onFocus, selectedId]);

  return (
    <div className="rooms">
      <div className="rooms-sidebar" style={{ width: sidebarWidth }}>
        <RoomList
          gateway={gateway}
          rooms={projectRooms}
          projects={data.projects}
          project={project}
          selectedId={selectedId}
          showArchive={showArchive}
          creating={creating}
          onProject={(next) => {
            setProject(next);
            setSelectedId(undefined);
          }}
          onSelect={select}
          onShowArchive={(open) => {
            setShowArchive(open);
            storage.setItem(ARCHIVE_KEY, String(open));
          }}
          onCreate={createRoom}
        />
      </div>
      <Splitter
        value={sidebarWidth}
        min={240}
        max={460}
        controls="before"
        onChange={setSidebarWidth}
        onDragEnd={(width) => storage.setItem(SIDEBAR_KEY, String(width))}
        ariaLabel="Resize rooms sidebar"
      />
      <section className="rooms-main">
        {data.loading && data.rooms.length === 0 ? (
          <LoadingMark label="Loading rooms" />
        ) : data.error && data.rooms.length === 0 ? (
          <div className="room-empty-state">
            <Eyebrow>Rooms unavailable</Eyebrow>
            <h1>Lost contact with the control plane</h1>
            <p>{data.error.message}</p>
            <Button variant="ghost" onClick={() => location.reload()}>Retry</Button>
          </div>
        ) : selected ? (
          <SpecDetail
            key={selected.spec.id}
            gateway={gateway}
            specId={selected.spec.id}
            onOpenSpec={(id) => {
              const room = data.rooms.find((candidate) => candidate.spec.id === id);
              if (room) {
                setProject(room.spec.project);
                select(room);
              }
            }}
            onBack={() => {}}
            embedded
            eventDebounceMs={0}
          />
        ) : (
          <div className="room-empty-state">
            <Eyebrow>{project || "Your project"}</Eyebrow>
            <h1>Start the conversation</h1>
            <p>Give the room a title to start. You can add the details later.</p>
          </div>
        )}
      </section>
    </div>
  );
}
