import { cx } from "../components/cx";
import { Cross, Plus } from "../components/icons";
import { Input } from "../components/Input";
import { Button } from "../components/ui";
import type { Pair, RepoForm } from "./definitionForms";

/**
 * The field groups a definition's forms share: rows of names and values, rows of single
 * values, a repo's URL, path and branch, and a section's JSON with its line numbers.
 */

const replaced = <T,>(rows: T[], index: number, row: T) => rows.map((r, i) => (i === index ? row : r));
const without = <T,>(rows: T[], index: number) => rows.filter((_, i) => i !== index);

export function PairRows({
  label,
  rows,
  onChange,
  keyHint,
  valueHint,
  addLabel,
}: {
  label: string;
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  keyHint: string;
  valueHint: string;
  addLabel: string;
}) {
  return (
    <div className="def-group">
      <span className="def-group__label">{label}</span>
      {rows.map((row, index) => (
        <div className="def-row" key={index}>
          <input
            className="input def-row__key"
            aria-label={`${label} name`}
            placeholder={keyHint}
            value={row.key}
            onChange={(e) => onChange(replaced(rows, index, { ...row, key: e.target.value }))}
          />
          <input
            className="input"
            aria-label={`${label} value`}
            placeholder={valueHint}
            value={row.value}
            onChange={(e) => onChange(replaced(rows, index, { ...row, value: e.target.value }))}
          />
          <RemoveRow label={`Remove ${row.key || label}`} onRemove={() => onChange(without(rows, index))} />
        </div>
      ))}
      <AddRow label={addLabel} onAdd={() => onChange([...rows, { key: "", value: "" }])} />
    </div>
  );
}

export function TextRows({
  label,
  rows,
  onChange,
  hint,
  addLabel,
}: {
  label: string;
  rows: string[];
  onChange: (rows: string[]) => void;
  hint: string;
  addLabel: string;
}) {
  return (
    <div className="def-group">
      <span className="def-group__label">{label}</span>
      {rows.map((row, index) => (
        <div className="def-row" key={index}>
          <input
            className="input"
            aria-label={label}
            placeholder={hint}
            value={row}
            onChange={(e) => onChange(replaced(rows, index, e.target.value))}
          />
          <RemoveRow label={`Remove ${row || label}`} onRemove={() => onChange(without(rows, index))} />
        </div>
      ))}
      <AddRow label={addLabel} onAdd={() => onChange([...rows, ""])} />
    </div>
  );
}

export function RepoRows({ rows, onChange }: { rows: RepoForm[]; onChange: (rows: RepoForm[]) => void }) {
  return (
    <div className="def-group">
      <span className="def-group__label">Repos</span>
      {rows.map((row, index) => (
        <div className="def-row def-row--repo" key={index}>
          <input
            className="input"
            aria-label="Repo URL"
            placeholder="https://github.com/acme/web.git"
            value={row.url}
            onChange={(e) => onChange(replaced(rows, index, { ...row, url: e.target.value }))}
          />
          <input
            className="input"
            aria-label="Repo path"
            placeholder="path"
            value={row.path}
            onChange={(e) => onChange(replaced(rows, index, { ...row, path: e.target.value }))}
          />
          <input
            className="input"
            aria-label="Repo branch"
            placeholder="branch"
            value={row.branch}
            onChange={(e) => onChange(replaced(rows, index, { ...row, branch: e.target.value }))}
          />
          <RemoveRow label={`Remove ${row.url || "repo"}`} onRemove={() => onChange(without(rows, index))} />
        </div>
      ))}
      <AddRow label="Repo" onAdd={() => onChange([...rows, { url: "", path: "", branch: "" }])} />
    </div>
  );
}

/** A section's JSON, numbered by line, the line a refusal names marked. */
export function JsonEditor({
  label,
  text,
  onChange,
  errorLine,
  readOnly = false,
}: {
  label: string;
  text: string;
  onChange?: (text: string) => void;
  errorLine?: number | null;
  readOnly?: boolean;
}) {
  const lines = Math.max(text.split("\n").length, 1);
  return (
    <div className="def-json" data-testid="def-json">
      <span className="def-group__label">{label} · JSON</span>
      <div className="def-json__frame">
        <div className="def-json__gutter" aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <span key={i} className={cx(errorLine === i + 1 && "is-error")}>
              {i + 1}
            </span>
          ))}
        </div>
        <textarea
          className="def-json__text"
          aria-label={`${label} JSON`}
          spellCheck={false}
          rows={Math.max(lines, 8)}
          value={text}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
        />
      </div>
    </div>
  );
}

export function LabeledInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "numeric" | "text";
}) {
  return (
    <Input
      id={id}
      label={label}
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function RemoveRow({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button type="button" className="def-row__remove" aria-label={label} onClick={onRemove}>
      <Cross size={14} />
    </button>
  );
}

function AddRow({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <Button variant="ghost" className="def-add" onClick={onAdd}>
      <Plus size={14} /> {label}
    </Button>
  );
}
