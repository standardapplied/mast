import type { AgentView } from "../../shared/sail-models";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CaretDown, CaretRight, Plus } from "../components/icons";
import { Dialog } from "../components/Dialog";
import { Input } from "../components/Input";
import { Select } from "../components/Select";
import { Tooltip } from "../components/Tooltip";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { relativeTime, SECTION_LABELS, SECTION_TONES, sectionRooms, type RoomView } from "./rooms";

export function RoomList({
  rooms,
  projects,
  project,
  selectedId,
  showArchive,
  creating,
  gateway,
  now = Date.now(),
  workingIds = new Set(),
  onProject,
  onSelect,
  onShowArchive,
  onCreate,
}: {
  gateway: Pick<Gateway, "listAgents">;
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
  onCreate: (title: string, project: string, agent?: string) => Promise<boolean>;
}) {
  const [newRoom, setNewRoom] = useState(false);
  const [title, setTitle] = useState("");
  const [newProject, setNewProject] = useState(project);
  const [agent, setAgent] = useState("claude-code");
  const [agents, setAgents] = useState<AgentView[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!newRoom) return;
    let cancelled = false;
    void gateway.listAgents().then((result) => {
      if (cancelled || !result.ok) return;
      setAgents(result.value.agents);
      setAgent((current) => current || result.value.agents[0]?.name || "");
    });
    return () => {
      cancelled = true;
    };
  }, [gateway, newRoom]);

  useEffect(() => {
    if (!newRoom) setNewProject(project);
  }, [newRoom, project]);

  useEffect(() => {
    if (newRoom) titleRef.current?.focus();
  }, [newRoom]);

  const closeCreate = () => {
    setNewRoom(false);
    setTitle("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const created = await onCreate(title, project || newProject, agent || undefined);
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

      <Dialog
        isOpen={newRoom}
        onClose={closeCreate}
        size="sm"
        title="Create a room"
        footer={
          <>
            <Button variant="ghost" disabled={creating} onClick={closeCreate}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-room-form"
              disabled={creating || !title.trim() || !(project || newProject)}
            >
              {creating ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <form
          id="create-room-form"
          className="room-create-form"
          onSubmit={(event) => void submit(event)}
        >
          <p className="room-create-hint">
            Give the room a title to start. You can add the details later.
          </p>
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
          <Select
            value={agent}
            options={[
              { value: "", label: "No agent" },
              ...agents.map((candidate) => ({
                value: candidate.name,
                label: candidate.display_name,
              })),
            ]}
            onChange={setAgent}
            placeholder="Agent"
            aria-label="Agent"
          />
          <p className="room-create-hint">
            The agent joins the room with full access and answers every message. Dismiss it any
            time.
          </p>
        </form>
      </Dialog>

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
                  key={room.room.id}
                  className={`room-row${selectedId === room.room.id ? " is-selected" : ""}`}
                  onClick={() => onSelect(room)}
                  data-testid={`room-${room.room.id}`}
                  aria-current={selectedId === room.room.id ? "page" : undefined}
                >
                  <span className={`room-row-id-label${room.unread ? " is-unread" : ""}`}>
                    {room.room.id}
                  </span>
                  {room.needsReply && (
                    <span
                      className="room-needs-reply"
                      data-testid={`needs-reply-${room.room.id}`}
                      aria-label="Needs your reply"
                    >
                      ?
                    </span>
                  )}
                  {workingIds.has(room.room.id) && (
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
