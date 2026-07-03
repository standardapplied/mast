import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

/**
 * A deliberately minimal terminal harness for the Tauri spike: it opens a PTY
 * on the devbox over the russh session, streams the raw bytes back through a
 * Tauri event, and sends keystrokes the other way. It proves the terminal half
 * of Mast works in-process on desktop AND mobile — the pipe that a real
 * emulator (ghostty-web / xterm, pending dependency approval) will render.
 *
 * Not a full VT: escape sequences pass through to a <pre>. Enough to run
 * `ls`, `top`, and confirm bytes flow end to end on a real phone.
 */

const KEY_BYTES: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
};

function keyToBytes(e: React.KeyboardEvent): string | null {
  if (e.ctrlKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }
  if (KEY_BYTES[e.key]) return KEY_BYTES[e.key]!;
  if (e.key.length === 1 && !e.metaKey) return e.key;
  return null;
}

export function TerminalPane() {
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("connecting…");
  const idRef = useRef(crypto.randomUUID());
  const decoderRef = useRef(new TextDecoder());
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const id = idRef.current;
    const decoder = decoderRef.current;
    let alive = true;

    const dataOff = listen<number[]>(`terminal://data/${id}`, (e) => {
      if (!alive) return;
      const text = decoder.decode(new Uint8Array(e.payload), { stream: true });
      setOutput((prev) => (prev + text).slice(-200_000));
    });
    const exitOff = listen(`terminal://exit/${id}`, () => setStatus("session closed"));

    invoke("terminal_open", { id, cols: 100, rows: 30 })
      .then(() => alive && setStatus("connected"))
      .catch((err) => alive && setStatus(`failed: ${err}`));

    return () => {
      alive = false;
      void invoke("terminal_close", { id }).catch(() => {});
      void dataOff.then((off) => off());
      void exitOff.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const bytes = keyToBytes(e);
    if (bytes === null) return;
    e.preventDefault();
    void invoke("terminal_write", {
      id: idRef.current,
      data: Array.from(new TextEncoder().encode(bytes)),
    }).catch(() => {});
  };

  return (
    <div className="terminal-pane">
      <header className="terminal-pane__bar">
        <span className="terminal-pane__title">devbox — russh PTY</span>
        <span className="terminal-pane__status">{status}</span>
      </header>
      <pre
        ref={preRef}
        className="terminal-pane__screen"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {output || "Click here and type — bytes travel over the in-process SSH session.\n"}
      </pre>
    </div>
  );
}
