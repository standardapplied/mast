import { Component, type ErrorInfo, type ReactNode } from "react";
import { logError } from "../errorLog";

/**
 * The last line of defense for the whole tree: React unmounts everything on an uncaught render
 * error, which in a desktop shell is a blank window with no way to see why or to recover. This
 * boundary keeps the error on screen, reports it through {@link report} (the shell forwards it to
 * stderr so a Terminal launch shows it), and offers the two recoveries a user can actually take:
 * reload, or reset the persisted terminal arrangements and reload — the one stored state that a
 * bad layout could re-trigger on every launch.
 */
export class CrashScreen extends Component<
  { children: ReactNode; report?: (message: string) => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const message = `${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`;
    logError("render", message);
    this.props.report?.(message);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen" data-testid="crash-screen" role="alert">
        <h1 className="crash-screen__title">Mast hit an error it could not recover from</h1>
        <pre className="crash-screen__detail">{`${error.message}\n\n${error.stack ?? ""}`}</pre>
        <div className="crash-screen__actions">
          <button type="button" className="term-overlay__btn" onClick={() => location.reload()}>
            Reload
          </button>
          <button
            type="button"
            className="term-overlay__btn"
            onClick={() => {
              resetTerminalLayouts();
              location.reload();
            }}
          >
            Reset terminal layouts and reload
          </button>
        </div>
      </div>
    );
  }
}

/** Forgets every stored pane arrangement; sessions on the host are untouched. */
export function resetTerminalLayouts(): void {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("mast.panes."));
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* storage is a convenience */
  }
}
