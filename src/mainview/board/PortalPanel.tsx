import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { LoadingMark } from "../components/Loading";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { refusalDetail } from "./snapshots";
import {
  failureLine,
  headline,
  localAddress,
  portLabel,
  SETTLE_EVERY_MS,
  SETTLE_LOOKS,
  stateLabel,
  type PortalPort,
  type PortalView,
} from "./portal";

/**
 * The portal sheet: opening it asks the box to bring the project's stack up, and the core
 * forwards every port that listens to this Mac. While a port is still starting the sheet looks
 * again, so its rows settle as the stack comes up, and the browser opens at the first process
 * that listens, once. A port that exited shows the last line it wrote and a Copy for it; a
 * service shows the address a client on this Mac reaches it at. A refusal (a stopped
 * container, a read-only session) is the box's own sentence.
 */
export function PortalPanel({
  gateway,
  project,
  openUrl,
  copyText,
  schedule = (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  onClose,
}: {
  gateway: Gateway;
  project: string;
  openUrl: (url: string) => void;
  copyText: (text: string) => void;
  schedule?: (run: () => void, ms: number) => () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<PortalView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const opened = useRef(false);
  const looks = useRef(0);

  const take = useCallback(
    (next: PortalView) => {
      setView(next);
      if (next.url && !opened.current) {
        opened.current = true;
        openUrl(next.url);
      }
    },
    [openUrl],
  );

  useEffect(() => {
    let cancel = () => {};
    let live = true;
    const look = async (ask: () => ReturnType<Gateway["portalOpen"]>) => {
      const result = await ask();
      if (!live) return;
      if (!result.ok) {
        setRefusal(refusalDetail(result.error));
        return;
      }
      take(result.value);
      if (!result.value.settled && looks.current < SETTLE_LOOKS) {
        looks.current += 1;
        cancel = schedule(() => void look(() => gateway.portalRefresh(project)), SETTLE_EVERY_MS);
      }
    };
    void look(() => gateway.portalOpen(project));
    return () => {
      live = false;
      cancel();
    };
  }, [gateway, project, schedule, take]);

  const stop = async () => {
    setStopping(true);
    setRefusal(null);
    const result = await gateway.portalStop(project);
    setStopping(false);
    if (result.ok) {
      opened.current = false;
      setView(result.value);
    } else {
      setRefusal(refusalDetail(result.error));
    }
  };

  const copy = (key: string, text: string) => {
    copyText(text);
    setCopied(key);
  };

  return (
    <Dialog isOpen onClose={onClose} title={`Portal — ${project}`} size="md">
      <div className="portal-panel" data-testid="portal-panel">
        {refusal && (
          <p className="dispatch-block" data-testid="portal-refusal">
            {refusal}
          </p>
        )}
        {view === null && !refusal && <LoadingMark label={`Bringing ${project} up`} />}
        {view && (
          <>
            <p className="portal-panel__headline" data-testid="portal-headline">
              {headline(view)}
            </p>
            <div className="portal-panel__rows">
              {view.ports.map((port) => (
                <PortRow
                  key={`${port.kind}:${port.name}:${port.port}`}
                  project={project}
                  port={port}
                  copied={copied}
                  onCopy={copy}
                  onOpen={openUrl}
                />
              ))}
            </div>
            <div className="portal-panel__actions">
              <span className="portal-panel__hint">
                The agent can bring it up too: ask it to start the app.
              </span>
              <Button
                variant="ghost"
                disabled={stopping}
                onClick={() => void stop()}
                data-testid="portal-stop"
              >
                {stopping ? "Stopping…" : "Stop processes"}
              </Button>
              {view.url && (
                <Button onClick={() => openUrl(view.url!)} data-testid="portal-open">
                  Open in browser
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function PortRow({
  project,
  port,
  copied,
  onCopy,
  onOpen,
}: {
  project: string;
  port: PortalPort;
  copied: string | null;
  onCopy: (key: string, text: string) => void;
  onOpen: (url: string) => void;
}) {
  const key = `${port.kind}:${port.name}:${port.port}`;
  const address = localAddress(port);
  const failed = port.state === "exited" || port.state === "timeout";
  return (
    <div className="portal-row" data-state={port.state} data-testid={`portal-port-${port.name}`}>
      <span className="portal-row__dot" aria-hidden="true" />
      <div className="portal-row__what">
        <span className="portal-row__name">{port.name}</span>
        <span className="portal-row__kind">{port.kind}</span>
        {failed && (
          <span className="portal-row__detail" data-testid={`portal-detail-${port.name}`}>
            {stateLabel(port)}
            {port.detail ? `: ${port.detail}` : ""}
          </span>
        )}
      </div>
      <span className="portal-row__port">{portLabel(port)}</span>
      <span className="portal-row__action">
        {failed ? (
          <Button variant="ghost" onClick={() => onCopy(key, failureLine(project, port))}>
            {copied === key ? "Copied" : "Copy"}
          </Button>
        ) : port.state !== "listening" || address === null ? (
          <span className="portal-row__state">{stateLabel(port)}</span>
        ) : port.kind === "process" ? (
          <Button variant="ghost" onClick={() => onOpen(`http://${address}`)}>
            Open
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => onCopy(key, address)}>
            {copied === key ? "Copied" : "Copy address"}
          </Button>
        )}
      </span>
    </div>
  );
}
