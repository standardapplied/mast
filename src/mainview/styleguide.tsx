import { useState, type ReactNode } from "react";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME, type TerminalTheme } from "./ansi";
import { DateTimePicker } from "./components/DateTimePicker";
import { Dialog } from "./components/Dialog";
import { Input } from "./components/Input";
import { KanbanBoard, KanbanCard, KanbanColumn } from "./components/Kanban";
import { Select } from "./components/Select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/Tabs";
import { ON_OFF, ToggleButton } from "./components/ToggleButton";
import { Textarea } from "./components/Textarea";
import { ToastProvider, useToast } from "./components/Toast";
import { Badge, Button, Card, Eyebrow } from "./components/ui";
import type { TimeValue } from "./lib/date-utils";
import type { ThemeController, ThemeMode } from "./theme";

const COLOR_TOKENS = [
  "background",
  "surface",
  "background-deep",
  "foreground",
  "muted-foreground",
  "subtle-foreground",
  "border",
  "grid-line",
  "primary",
  "primary-hover",
  "on-primary",
  "error",
  "warning",
  "success",
  "info",
] as const;

const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

const AGENTS = [
  { value: "claude-code", label: "claude-code", description: "Anthropic coding agent" },
  { value: "codex", label: "codex", description: "OpenAI coding agent" },
  { value: "gemini", label: "gemini", description: "Google coding agent" },
];

const PROJECTS = [
  { value: "sail", label: "sail", description: "Control plane" },
  { value: "mast", label: "mast", description: "Desktop cockpit" },
  { value: "chorus", label: "chorus", description: "Client contract" },
];

function Section({ index, title, children }: { index: string; title: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <Eyebrow>{index}</Eyebrow>
        <h2 style={{ fontSize: 22 }}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Swatch({ token }: { token: string }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        style={{
          height: 48,
          background: `var(--${token})`,
          border: "1px solid var(--border-strong)",
        }}
      />
      <code style={{ fontSize: 11, color: "var(--muted-foreground)" }}>--{token}</code>
    </div>
  );
}

function AnsiStrip({ theme, label }: { theme: TerminalTheme; label: string }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Eyebrow>{label}</Eyebrow>
      <div className="ansi-strip" style={{ background: theme.background, padding: 8 }}>
        {theme.ansi.map((color, i) => (
          <div key={i} className="ansi-chip" style={{ background: color }} title={`ansi ${i}`} />
        ))}
      </div>
    </div>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  const [guarded, setGuarded] = useState(false);
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <input type="checkbox" checked={guarded} onChange={(e) => setGuarded(e.target.checked)} />
        veto close (onBeforeClose)
      </label>
      <Dialog
        isOpen={open}
        onClose={() => setOpen(false)}
        onBeforeClose={guarded ? () => false : undefined}
        title="Dispatch spec"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Dispatch</Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 14, color: "var(--muted-foreground)" }}>
          Escape, backdrop click, and the close button all route through the async
          <code> onBeforeClose</code> gate — tick the veto box and try to close. On a narrow window
          this panel becomes a bottom sheet.
        </p>
      </Dialog>
    </div>
  );
}

function ToastDemo() {
  const { showToast } = useToast();
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <Button variant="ghost" onClick={() => showToast("success", "Spec mast-design-system dispatched.")}>
        Success toast
      </Button>
      <Button variant="ghost" onClick={() => showToast("error", "Agent failed: exit code 1 on bun test.")}>
        Error toast
      </Button>
      <Button variant="ghost" onClick={() => showToast("info", "Sync complete — 3 specs updated.")}>
        Info toast
      </Button>
    </div>
  );
}

function StyleguideBody({ theme }: { theme: ThemeController }) {
  const [mode, setMode] = useState<ThemeMode>(theme.mode());
  const [agent, setAgent] = useState("claude-code");
  const [project, setProject] = useState("");
  const [body, setBody] = useState("");
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<TimeValue | null>(null);
  const [month, setMonth] = useState<Date | null>(null);
  const [onOff, setOnOff] = useState("on");
  const [toggleValue, setToggleValue] = useState("board");

  const selectMode = (next: ThemeMode) => {
    theme.setMode(next);
    setMode(next);
  };

  return (
    <div style={{ minHeight: "100vh" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "48px 32px", display: "grid", gap: 48 }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <Eyebrow>SAIL design system</Eyebrow>
            <h1 style={{ fontSize: 34 }}>Mast styleguide</h1>
          </div>
          <div style={{ display: "flex", border: "1px solid var(--border-strong)" }}>
            {THEME_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className="tab"
                aria-selected={m === mode}
                onClick={() => selectMode(m)}
                data-testid={`theme-${m}`}
              >
                {m}
              </button>
            ))}
          </div>
        </header>

        <Section index="01" title="Typography">
          <Card>
            <div style={{ display: "grid", gap: 12 }}>
              <h1 style={{ fontSize: 32 }}>Newsreader — editorial display serif</h1>
              <p style={{ margin: 0, fontSize: 15 }}>
                Switzer carries body and interface text. It stays quiet, reads dense, and leaves the
                voice to the serif and the blueprint labels.
              </p>
              <code style={{ fontSize: 13 }}>JetBrains Mono — technical labels, code, terminals</code>
              <Eyebrow>Eyebrow — uppercase mono, 0.20em tracking</Eyebrow>
            </div>
          </Card>
        </Section>

        <Section index="02" title="Color tokens">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16 }}>
            {COLOR_TOKENS.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </div>
        </Section>

        <Section index="03" title="Buttons">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Button>Dispatch</Button>
            <Button variant="ghost">Review</Button>
            <Button disabled>Disabled</Button>
            <Button variant="ghost" disabled>
              Disabled
            </Button>
          </div>
        </Section>

        <Section index="04" title="Forms">
          <Card>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Input id="spec-id" label="Spec id" placeholder="mast-design-system" />
              <Input
                id="spec-title"
                label="Title"
                defaultValue="Mast design"
                error="Title must be at least 12 characters"
              />
              <Select label="Agent" value={agent} onChange={setAgent} options={AGENTS} />
              <Select
                label="Project (searchable)"
                value={project}
                onChange={setProject}
                options={PROJECTS}
                searchable
                placeholder="Search projects…"
              />
              <div style={{ gridColumn: "1 / -1" }}>
                <Textarea
                  id="spec-body"
                  label="Body"
                  placeholder="Overview, scope, acceptance…"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  autoGrow
                  showCount
                  maxLength={280}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <ToggleButton className="toggle-sm" options={ON_OFF} value={onOff} onChange={setOnOff} />
                <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
                  On/off toggle — {onOff}
                </span>
              </div>
              <ToggleButton
                options={[
                  { value: "board", label: "Board" },
                  { value: "list", label: "List" },
                ]}
                value={toggleValue}
                onChange={setToggleValue}
              />
            </div>
          </Card>
        </Section>

        <Section index="05" title="Date & time">
          <Card>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <DateTimePicker
                label="Dispatch after"
                variant="datetime"
                dateValue={date}
                timeValue={time}
                onDateChange={setDate}
                onTimeChange={setTime}
              />
              <DateTimePicker
                label="Billing month"
                variant="month"
                dateValue={month}
                onDateChange={setMonth}
              />
            </div>
          </Card>
        </Section>

        <Section index="06" title="Tabs & status">
          <Tabs defaultValue="specs">
            <TabsList>
              <TabsTrigger value="specs">Specs</TabsTrigger>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="terminal" disabled>
                Terminal
              </TabsTrigger>
            </TabsList>
            <TabsContent value="specs">
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Badge>Draft</Badge>
                  <Badge>Pending</Badge>
                  <Badge tone="accent">In progress</Badge>
                  <Badge tone="warning">Review</Badge>
                  <Badge tone="success">Done</Badge>
                  <Badge tone="error">Agent failed</Badge>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: "var(--subtle-foreground)" }}>
                  Text stays neutral; the dot alone carries status. Only a failed agent colors the
                  whole badge.
                </p>
              </div>
            </TabsContent>
            <TabsContent value="agents">
              <p style={{ margin: 0, color: "var(--muted-foreground)", fontSize: 14 }}>
                Agent monitor lands in its own spec.
              </p>
            </TabsContent>
          </Tabs>
        </Section>

        <Section index="07" title="Toasts">
          <ToastDemo />
        </Section>

        <Section index="08" title="Table">
          <Card>
            <table className="table">
            <thead>
              <tr>
                <th>Spec</th>
                <th>Assignee</th>
                <th>Agent</th>
                <th className="is-numeric">Tests</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td data-label="Spec">mast-design-system</td>
                <td data-label="Assignee">uday</td>
                <td data-label="Agent">claude-code</td>
                <td data-label="Tests" className="is-numeric">
                  69
                </td>
                <td data-label="Status">
                  <Badge tone="accent">In progress</Badge>
                </td>
              </tr>
              <tr>
                <td data-label="Spec">mast-api-client</td>
                <td data-label="Assignee">—</td>
                <td data-label="Agent">—</td>
                <td data-label="Tests" className="is-numeric">
                  0
                </td>
                <td data-label="Status">
                  <Badge>Draft</Badge>
                </td>
              </tr>
              <tr>
                <td data-label="Spec">mast-app-shell</td>
                <td data-label="Assignee">uday</td>
                <td data-label="Agent">claude-code</td>
                <td data-label="Tests" className="is-numeric">
                  30
                </td>
                <td data-label="Status">
                  <Badge tone="success">Done</Badge>
                </td>
              </tr>
              <tr>
                <td data-label="Spec">sail-watch-live-phase</td>
                <td data-label="Assignee">ravi</td>
                <td data-label="Agent">codex</td>
                <td data-label="Tests" className="is-numeric">
                  12
                </td>
                <td data-label="Status">
                  <Badge tone="error">Agent failed</Badge>
                </td>
              </tr>
            </tbody>
          </table>
          </Card>
        </Section>

        <Section index="09" title="Dialog">
          <DialogDemo />
        </Section>

        <Section index="10" title="Kanban">
          <KanbanBoard>
            <KanbanColumn title="Pending" count={2}>
              <KanbanCard title="mast-api-client" meta={<Badge>Pending</Badge>} />
              <KanbanCard title="mast-terminal" meta={<Badge>Pending</Badge>} />
            </KanbanColumn>
            <KanbanColumn title="In progress" count={1}>
              <KanbanCard
                title="mast-design-system"
                active
                meta={
                  <>
                    <Badge tone="accent">In progress</Badge>
                    <span>uday</span>
                  </>
                }
              />
            </KanbanColumn>
            <KanbanColumn title="Review" count={1}>
              <KanbanCard title="sail-watch-live-phase" meta={<Badge tone="warning">Review</Badge>} />
            </KanbanColumn>
          </KanbanBoard>
        </Section>

        <Section index="11" title="Terminal palettes">
          <Card>
            <div style={{ display: "grid", gap: 20 }}>
              <AnsiStrip theme={DARK_TERMINAL_THEME} label="Ink — ghostty dark" />
              <AnsiStrip theme={LIGHT_TERMINAL_THEME} label="Paper — ghostty light (dim pre-blended, no alpha washout)" />
            </div>
          </Card>
        </Section>
      </div>
    </div>
  );
}

export function Styleguide({ theme }: { theme: ThemeController }) {
  return (
    <ToastProvider>
      <StyleguideBody theme={theme} />
    </ToastProvider>
  );
}
