import { useState } from "react";
import { Badge, Button, Card, Eyebrow, Field, Input, Select, Tabs, Textarea } from "./components/ui";
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

function Section({ index, title, children }: { index: string; title: string; children: React.ReactNode }) {
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

export function Styleguide({ theme }: { theme: ThemeController }) {
  const [mode, setMode] = useState<ThemeMode>(theme.mode());
  const [tab, setTab] = useState("Specs");

  const selectMode = (next: string) => {
    theme.setMode(next as ThemeMode);
    setMode(next as ThemeMode);
  };

  return (
    <div className="grid-bg" style={{ minHeight: "100vh" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "48px 32px", display: "grid", gap: 48 }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <Eyebrow>SAIL design system</Eyebrow>
            <h1 style={{ fontSize: 34 }}>Mast styleguide</h1>
          </div>
          <div style={{ display: "flex", gap: 0, border: "1px solid var(--border-strong)" }}>
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
              <Field label="Spec id">
                <Input placeholder="mast-design-system" />
              </Field>
              <Field label="Agent">
                <Select defaultValue="claude-code">
                  <option value="claude-code">claude-code</option>
                  <option value="codex">codex</option>
                </Select>
              </Field>
              <div style={{ gridColumn: "1 / -1" }}>
                <Field label="Body">
                  <Textarea placeholder="Overview, scope, acceptance…" />
                </Field>
              </div>
            </div>
          </Card>
        </Section>

        <Section index="05" title="Tabs & status">
          <Tabs tabs={["Specs", "Agents", "Terminal"]} active={tab} onSelect={setTab} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Badge>Draft</Badge>
            <Badge tone="accent">Dispatched</Badge>
            <Badge tone="info">In progress</Badge>
            <Badge tone="warning">Review</Badge>
            <Badge tone="success">Done</Badge>
            <Badge tone="error">Agent failed</Badge>
          </div>
        </Section>

        <Section index="06" title="Table">
          <Card>
            <table className="table">
              <thead>
                <tr>
                  <th>Spec</th>
                  <th>Assignee</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>mast-design-system</td>
                  <td>uday</td>
                  <td>
                    <Badge tone="info">In progress</Badge>
                  </td>
                </tr>
                <tr>
                  <td>mast-api-client</td>
                  <td>—</td>
                  <td>
                    <Badge>Draft</Badge>
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>
        </Section>
      </div>
    </div>
  );
}
