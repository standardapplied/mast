import { useEffect, useState } from "react";
import type { Gateway } from "../gateway";
import { Dialog } from "./Dialog";
import { Button } from "./ui";

/**
 * Copy-pasteable diagnostics: environment facts plus the recent connection /
 * HTTP log tail from the Bun main. Secrets are redacted server-side before the
 * report crosses the RPC boundary.
 */
export function Diagnostics({ gateway, onClose }: { gateway: Gateway; onClose: () => void }) {
  const [report, setReport] = useState("Collecting…");
  const [logPath, setLogPath] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void gateway.diagnostics().then((d) => {
      if (!live) return;
      setReport(d.report);
      setLogPath(d.logPath);
    });
    return () => {
      live = false;
    };
  }, [gateway]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title="Diagnostics"
      size="lg"
      footer={
        <>
          {logPath && <span className="diag-path">{logPath}</span>}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy report"}</Button>
        </>
      }
    >
      <pre className="diag-report" data-testid="diagnostics-report">
        {report}
      </pre>
    </Dialog>
  );
}
