import { useCallback, useEffect, useRef, useState } from "react";

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

export function useUpdater(updater?: Updater): UpdaterView {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [version, setVersion] = useState("");
  const [available, setAvailable] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const pending = useRef<PendingUpdate | null>(null);

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
        .catch(() => auto || setPhase("error"));
    },
    [updater],
  );

  useEffect(() => {
    if (!updater) return;
    let alive = true;
    void updater.currentVersion().then((v) => alive && setVersion(v));
    const timer = setTimeout(() => alive && runCheck(true), AUTO_CHECK_DELAY);
    return () => {
      alive = false;
      clearTimeout(timer);
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
      .catch(() => setPhase("error"));
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
