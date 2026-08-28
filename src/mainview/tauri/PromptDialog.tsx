import { useState } from "react";
import { Dialog } from "../components/Dialog";
import { Input } from "../components/Input";
import { Button } from "../components/ui";

/** A one-field prompt (rename, new folder). */
export function PromptDialog({
  title,
  label,
  initial = "",
  confirmLabel = "OK",
  allowEmpty = false,
  onConfirm,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  /** Accept a blank submission (e.g. a rename where blank restores the default name). */
  allowEmpty?: boolean;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const submittable = trimmed.length > 0 || allowEmpty;
  const submit = () => submittable && onConfirm(trimmed);

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!submittable} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Input
        label={label}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
    </Dialog>
  );
}
