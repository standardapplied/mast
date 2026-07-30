import { useEffect, useRef, useState, type FormEvent } from "react";
import { CaretDown, CaretRight, Plus } from "../components/icons";
import { Input } from "../components/Input";
import { Select } from "../components/Select";
import { Tooltip } from "../components/Tooltip";
import { Button } from "../components/ui";
import { relativeTime, SECTION_LABELS, SECTION_TONES, sectionRooms, type RoomView } from "./rooms";

export function RoomList({
  rooms,
  projects,
  project,
  selectedId,
  showArchive,
  creating,
  now = Date.now(),
  workingIds = new Set(),
  onProject,
  onSelect,
  onShowArchive,
  onCreate,
}: {
  rooms: readonly RoomView[];
  projects: readonly string[];
  project: string;
  selectedId?: string;
  showArchive: boolean;
  creating: boolean;
  /** Injected clock so rows render deterministic relative times in tests. */
  now?: number;
  workingIds?: ReadonlySet<string>;
  onProject: (project: string) => void;
  onSelect: (room: RoomView) => void;
  onShowArchive: (show: boolean) => void;
  onCreate: (title: string, project: string) => Promise<boolean>;
}) {
  const [newRoom, setNewRoom] = useState(false);
  const [title, setTitle] = useState("");
  const [newProject, setNewProject] = useState(project);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!newRoom) setNewProject(project);
  }, [newRoom, project]);

  useEffect(() => {
    if (newRoom) titleRef.current?.focus();
  }, [newRoom]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const created = await onCreate(title, project || newProject);
    if (!created) return;
    setTitle("");
    setNewRoom(false);
  };

  return (
    <aside className="room-list">
      <div className="room-list-head">
        {projects.length > 0 && (
          <Select
            className="room-project"
            value={project}
            options={projects.map((name) => ({ value: name, label: name }))}
            onChange={onProject}
            placeholder="Project"
          />
        )}
        <Tooltip content="New room">
          <Button
            variant="ghost"
            icon
            aria-label="New room"
            onClick={() => setNewRoom(true)}
            disabled={newRoom}
          >
            <Plus size={16} />
          </Button>
        </Tooltip>
      </div>

      {newRoom && (
        <form className="room-new" onSubmit={(event) => void submit(event)}>
          {!project && (
            projects.length > 0 ? (
              <Select
                value={newProject}
                options={projects.map((name) => ({ value: name, label: name }))}
                onChange={setNewProject}
                placeholder="Project"
              />
            ) : (
              <Input
                value={newProject}
                onChange={(event) => setNewProject(event.target.value)}
                placeholder="Project"
                aria-label="Project"
                disabled={creating}
              />
            )
          )}
          <Input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Room title"
            aria-label="Room title"
            disabled={creating}
          />
          <div className="room-new-actions">
            <Button type="submit" disabled={creating || !title.trim() || !(project || newProject)}>
              {creating ? "Creating…" : "Create"}
            </Button>
            <Button
              variant="ghost"
              disabled={creating}
              onClick={() => {
                setNewRoom(false);
                setTitle("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="room-list-scroll">
        {sectionRooms(rooms).map(({ section, rooms: grouped }) => (
          <div key={section} className="room-section">
            {section === "archive" ? (
              <button
                type="button"
                className="room-section-head is-disclosure"
                aria-expanded={showArchive}
                data-testid="archive-section"
                onClick={() => onShowArchive(!showArchive)}
              >
                {showArchive ? <CaretDown size={12} /> : <CaretRight size={12} />}
                <span className={`room-section-mark tone-${SECTION_TONES.archive}`} />
                <span>{SECTION_LABELS.archive}</span>
                <span className="room-section-count">{grouped.length}</span>
              </button>
            ) : (
              <div className="room-section-head">
                <span className={`room-section-mark tone-${SECTION_TONES[section]}`} />
                {SECTION_LABELS[section]}
              </div>
            )}
            {(section !== "archive" || showArchive) &&
              grouped.map((room) => (
                <button
                  type="button"
                  key={room.spec.id}
                  className={`room-row${selectedId === room.spec.id ? " is-selected" : ""}`}
                  onClick={() => onSelect(room)}
                  data-testid={`room-${room.spec.id}`}
                  aria-current={selectedId === room.spec.id ? "page" : undefined}
                >
                  <span className={`room-row-title${room.unread ? " is-unread" : ""}`}>
                    {room.spec.title}
                  </span>
                  {workingIds.has(room.spec.id) && (
                    <span className="room-working-dot" aria-label="Agent working" />
                  )}
                  <time className="room-row-time">{relativeTime(room.activityAt, now)}</time>
                </button>
              ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
