import { useCallback, useEffect, useRef, useState } from "react";
import { logError } from "./errorLog";

/**
 * The auto-update seam. `Updater` is the transport-agnostic contract (the Tauri
 * entry injects a real one backed by `@tauri-apps/plugin-updater`; demo/tests
 * pass none, so the UI simply hides the update controls). `useUpdater` owns the
 * small state machine the user menu renders.
 */

export type PendingUpdate = {
  version: string;
  /** Download + install; reports fraction 0..1, or null when the size is unknown. */
  install: (onProgress: (fraction: number | null) => void) => Promise<void>;
};

export type Updater = {
  currentVersion: () => Promise<string>;
  check: () => Promise<PendingUpdate | null>;
  relaunch: () => Promise<void>;
  openReleases: () => Promise<void>;
};

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type UpdaterView = {
  enabled: boolean;
  phase: UpdaterPhase;
  version: string;
  available: string | null;
  progress: number | null;
  check: () => void;
  install: () => void;
  restart: () => void;
  openReleases: () => void;
};

const AUTO_CHECK_DELAY = 4000;
const PERIODIC_CHECK_MS = 12 * 60 * 60 * 1000;

export function useUpdater(updater?: Updater): UpdaterView {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [version, setVersion] = useState("");
  const [available, setAvailable] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const pending = useRef<PendingUpdate | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // `auto` (the launch check) stays quiet unless there's actually an update — a
  // manual check reports "up to date" / errors so the click has visible feedback.
  const runCheck = useCallback(
    (auto: boolean) => {
      if (!updater) return;
      if (!auto) setPhase("checking");
      void updater
        .check()
        .then((upd) => {
          if (upd) {
            pending.current = upd;
            setAvailable(upd.version);
            setPhase("available");
          } else if (!auto) {
            setPhase("current");
          }
        })
        .catch((e) => {
          logError("updater", `check: ${String(e)}`);
          if (!auto) setPhase("error");
        });
    },
    [updater],
  );

  useEffect(() => {
    if (!updater) return;
    let alive = true;
    void updater.currentVersion().then((v) => alive && setVersion(v));
    const initial = setTimeout(() => alive && runCheck(true), AUTO_CHECK_DELAY);
    // Keep checking while the app stays open, so an update published *after*
    // launch is noticed without a manual click or a restart — but never interrupt
    // an in-flight download / ready-to-restart state.
    const periodic = setInterval(() => {
      if (alive && phaseRef.current !== "downloading" && phaseRef.current !== "ready") {
        runCheck(true);
      }
    }, PERIODIC_CHECK_MS);
    return () => {
      alive = false;
      clearTimeout(initial);
      clearInterval(periodic);
    };
  }, [updater, runCheck]);

  const install = useCallback(() => {
    const upd = pending.current;
    if (!upd) return;
    setPhase("downloading");
    setProgress(0);
    void upd
      .install(setProgress)
      .then(() => setPhase("ready"))
      .catch((e) => {
        logError("updater", `install: ${String(e)}`);
        setPhase("error");
      });
  }, []);

  return {
    enabled: !!updater,
    phase,
    version,
    available,
    progress,
    check: () => runCheck(false),
    install,
    restart: () => void updater?.relaunch(),
    openReleases: () => void updater?.openReleases(),
  };
}
