/**
 * Renderer spike harness — wires the real {@link VtCore} (libghostty-vt) to the {@link
 * TerminalRenderer} and drives it with animated demo streams, so the WebGPU output can be eyeballed
 * against native Ghostty. Not shipped: this is the spike page's entry point, not app code.
 *
 * It reads the wasm bytes from `window.SPIKE_WASM` (the page inlines them), sizes a terminal to the
 * canvas, and runs a frame loop: write scene bytes → snapshot the damaged rows → draw. A row of
 * scenes exercises the parts that matter — glyph crispness, 24-bit color, motion under churn, and
 * box-drawing alignment.
 */

import { TerminalRenderer } from "../renderer";
import { VtCore } from "../vtCore";

const ESC = "\x1b";
const enc = new TextEncoder();

interface Scene {
  readonly name: string;
  reset(cols: number, rows: number): void;
  /** Bytes to feed the terminal for this frame. */
  step(cols: number, rows: number, tMs: number, dtMs: number): string;
  readonly cursor: boolean;
}

function sgrTrueColor(fg: [number, number, number], bg?: [number, number, number]): string {
  const f = `${ESC}[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
  const b = bg ? `${ESC}[48;2;${bg[0]};${bg[1]};${bg[2]}m` : "";
  return f + b;
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const truecolor: Scene = {
  name: "Truecolor",
  cursor: false,
  reset() {},
  step(cols, rows, t) {
    let out = `${ESC}[H`;
    const phase = t / 40;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const h = ((x / cols) * 360 + phase) % 360;
        const v = 0.25 + 0.75 * (y / rows);
        out += sgrTrueColor([245, 245, 250], hsv(h, 0.85, v)) + " ";
      }
    }
    out += `${ESC}[H${sgrTrueColor([12, 14, 20], [235, 236, 245])} 24-bit truecolor — ${cols}×${rows} — every cell a distinct hue ${ESC}[0m`;
    return out;
  },
};

const CODE = [
  ["kw", "pub async fn", "id", " drive", "pn", "<", "ty", "S", "pn", ">(", "id", "stream", "pn", ": ", "ty", "S", "pn", ") {"],
  ["cm", "  // reads run in their own cancel-safe task"],
  ["kw", "  let", "id", " (mut rd, mut wr) ", "op", "= ", "id", "split", "pn", "(stream);"],
  ["kw", "  loop", "pn", " {"],
  ["id", "    select", "pn", "! { ", "id", "frame ", "op", "= ", "id", "rx.recv", "pn", "() => {"],
  ["ty", "      Output", "pn", " { bytes, .. } => ", "id", "on_event", "pn", "(bytes),"],
  ["pn", "    } }"],
  ["pn", "  }"],
  ["pn", "}"],
];
const CODE_COLORS: Record<string, [number, number, number]> = {
  kw: [198, 120, 221],
  id: [220, 223, 228],
  ty: [86, 182, 194],
  pn: [130, 137, 151],
  op: [86, 182, 194],
  cm: [92, 99, 112],
  st: [152, 195, 121],
};

const LINES = CODE.map((line) => {
  const segs: { sgr: string; text: string }[] = [];
  for (let i = 0; i < line.length; i += 2) {
    segs.push({ sgr: sgrTrueColor(CODE_COLORS[line[i]] ?? CODE_COLORS.id), text: line[i + 1] });
  }
  return segs;
});
const TYPED_TOTAL = LINES.reduce((n, segs) => n + segs.reduce((m, s) => m + s.text.length, 0), 0);

const typing: Scene = {
  name: "Typing",
  cursor: true,
  _emitted: 0,
  _hold: 0,
  reset() {
    const s = this as { _emitted: number; _hold: number };
    s._emitted = 0;
    s._hold = 0;
  },
  step(_cols, _rows, _t, dt) {
    const s = this as unknown as { _emitted: number; _hold: number };
    if (s._emitted >= TYPED_TOTAL) {
      s._hold += dt;
      if (s._hold > 2600) {
        s._emitted = 0;
        s._hold = 0;
      }
    } else {
      s._emitted = Math.min(TYPED_TOTAL, s._emitted + dt * 0.09);
    }
    let budget = Math.floor(s._emitted);
    let out = `${ESC}[2J${ESC}[H`;
    for (let li = 0; li < LINES.length; li++) {
      let lineOut = "";
      let stop = false;
      for (const seg of LINES[li]) {
        if (budget <= 0) {
          stop = true;
          break;
        }
        const take = Math.min(seg.text.length, budget);
        lineOut += seg.sgr + seg.text.slice(0, take);
        budget -= take;
        if (take < seg.text.length) {
          stop = true;
          break;
        }
      }
      out += lineOut + `${ESC}[0m`;
      if (stop) break;
      if (li < LINES.length - 1) out += "\r\n";
    }
    return out;
  },
} as Scene & { _emitted: number; _hold: number };

const rain: Scene = {
  name: "Matrix",
  cursor: false,
  _cols: [] as { y: number; speed: number; len: number }[],
  reset(cols) {
    (this as { _cols: unknown[] })._cols = Array.from({ length: cols }, () => ({
      y: -Math.floor(Math.random() * 30),
      speed: 0.3 + Math.random() * 0.9,
      len: 6 + Math.floor(Math.random() * 14),
    }));
  },
  step(cols, rows, _t, dt) {
    const s = this as unknown as { _cols: { y: number; speed: number; len: number }[] };
    let out = "";
    const glyphs = "ｱｲｳｴｵｶｷｸ01234789ABCDEFｦｧｨΞΨΩλμ";
    for (let x = 0; x < cols; x++) {
      const c = s._cols[x];
      c.y += (c.speed * dt) / 45;
      const head = Math.floor(c.y);
      for (let k = 0; k < c.len; k++) {
        const yy = head - k;
        if (yy < 0 || yy >= rows) continue;
        const ch = glyphs[Math.floor(Math.random() * glyphs.length)];
        const bright = k === 0 ? 255 : Math.max(30, 220 - k * 18);
        const g = k === 0 ? [200, 255, 210] : [30, bright, 90];
        out += `${ESC}[${yy + 1};${x + 1}H${sgrTrueColor(g as [number, number, number])}${ch}`;
      }
      const tail = head - c.len;
      if (tail >= 0 && tail < rows) out += `${ESC}[${tail + 1};${x + 1}H `;
      if (head - c.len > rows) {
        c.y = -Math.floor(Math.random() * 20);
        c.speed = 0.3 + Math.random() * 0.9;
        c.len = 6 + Math.floor(Math.random() * 14);
      }
    }
    return out + `${ESC}[0m`;
  },
} as Scene & { _cols: { y: number; speed: number; len: number }[] };

const dashboard: Scene = {
  name: "TUI",
  cursor: false,
  reset() {},
  step(cols, _rows, t) {
    const w = Math.min(cols, 72);
    const dim = sgrTrueColor([70, 78, 92]);
    const teal = sgrTrueColor([77, 224, 200]);
    const text = sgrTrueColor([200, 208, 220]);
    const amber = sgrTrueColor([224, 162, 77]);
    const inner = w - 4;
    let out = `${ESC}[2J${ESC}[H`;
    const at = (y: number, s: string) => {
      out += `${ESC}[${y};1H${s}`;
    };
    const box = (y: number, content: string) => {
      at(y, teal + "│ " + content + `${ESC}[${y};${w}H` + teal + "│" + `${ESC}[0m`);
    };
    at(1, teal + "┌" + "─".repeat(w - 2) + "┐");
    box(2, text + "sail · session host" + dim + "   pty transport monitor");
    at(3, teal + "├" + "─".repeat(w - 2) + "┤");
    const gauges = [
      ["throughput", 0.5 + 0.45 * Math.sin(t / 700), [77, 224, 200]],
      ["frames/s  ", 0.9 + 0.08 * Math.sin(t / 300), [152, 195, 121]],
      ["gpu upload", 0.3 + 0.2 * Math.sin(t / 500 + 1), [224, 162, 77]],
      ["backlog   ", 0.15 + 0.12 * Math.sin(t / 900 + 2), [198, 120, 221]],
    ] as const;
    gauges.forEach((g, i) => {
      const [label, val, col] = g;
      const barW = inner - 18;
      const fill = Math.max(0, Math.min(barW, Math.round(val * barW)));
      const bar =
        sgrTrueColor(col as [number, number, number]) +
        "█".repeat(fill) +
        dim +
        "░".repeat(barW - fill);
      box(5 + i, text + label + "  " + bar + " " + amber + `${Math.round(val * 100)}%`.padStart(4));
    });
    at(9, teal + "├" + "─".repeat(w - 2) + "┤");
    box(10, dim + "session     state    writer   attached");
    const rowsData = [
      ["s1 lounge", "live", "uday", "2"],
      ["s2 claude", "live", "uday", "1"],
      ["s3 build", "ended", "mady", "0"],
    ];
    rowsData.forEach((r, i) => {
      const state = r[1] === "live" ? sgrTrueColor([152, 195, 121]) : sgrTrueColor([224, 100, 100]);
      box(11 + i, text + r[0].padEnd(11) + state + r[1].padEnd(9) + text + r[2].padEnd(9) + r[3]);
    });
    at(15, teal + "└" + "─".repeat(w - 2) + "┘");
    return out + `${ESC}[0m`;
  },
};

const SCENES = [typing, truecolor, rain, dashboard];

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function main() {
  const wasm = (window as unknown as { SPIKE_WASM?: Uint8Array }).SPIKE_WASM;
  if (!wasm) throw new Error("spike: window.SPIKE_WASM not set");

  const fontFamily = '"JetBrains Mono", ui-monospace, monospace';
  const fontPx = 15;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  await document.fonts.load(`${fontPx}px "JetBrains Mono"`);
  await document.fonts.ready;

  const canvas = el<HTMLCanvasElement>("screen");
  const renderer = await TerminalRenderer.create(canvas, { fontFamily, fontPx, linePad: 0.25, dpr });
  el("backend").textContent = renderer.backendName.toUpperCase();
  el("backend").dataset.kind = renderer.backendName;

  const { w: cellW, h: cellH } = renderer.cellSize;
  const stage = el("stage");
  const cols = Math.max(20, Math.floor((stage.clientWidth * dpr - 8) / cellW));
  const rows = Math.max(10, Math.floor((stage.clientHeight * dpr - 8) / cellH));

  const core = await VtCore.create(wasm, cols, rows);
  renderer.resize(cols, rows);
  canvas.style.width = `${(cols * cellW) / dpr}px`;
  canvas.style.height = `${(rows * cellH) / dpr}px`;
  el("dims").textContent = `${cols}×${rows}`;
  el("cellpx").textContent = `${Math.round(cellW / dpr)}×${Math.round(cellH / dpr)}px`;

  let scene = SCENES[0];
  let sceneStart = 0;
  const selectScene = (s: Scene, tMs: number) => {
    scene = s;
    sceneStart = tMs;
    s.reset(cols, rows);
    core.write(enc.encode(`${ESC}[2J${ESC}[H${ESC}[0m` + (s.cursor ? `${ESC}[?25h` : `${ESC}[?25l`)));
    document.querySelectorAll<HTMLButtonElement>(".scene").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.name === s.name));
    });
  };

  document.querySelectorAll<HTMLButtonElement>(".scene").forEach((b) => {
    b.addEventListener("click", () => {
      const s = SCENES.find((x) => x.name === b.dataset.name);
      if (s) selectScene(s, performance.now());
    });
  });

  let last = performance.now();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let blink = 0;
  scene.reset(cols, rows);
  core.write(enc.encode(`${ESC}[?25h`));

  function frame(now: number) {
    const dt = Math.min(64, now - last);
    last = now;
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc >= 500) {
      el("fps").textContent = String(Math.round((fpsFrames * 1000) / fpsAcc));
      fpsAcc = 0;
      fpsFrames = 0;
    }

    const bytes = scene.step(cols, rows, now - sceneStart, dt);
    if (bytes) core.write(enc.encode(bytes));

    const snap = core.snapshot();
    if (snap.dirty !== "none") {
      renderer.apply(snap);
      core.clean();
    }
    blink = (blink + dt) % 1060;
    const cur = core.cursor();
    renderer.setCursor({ ...cur, visible: cur.visible && (!scene.cursor || blink < 600) });
    renderer.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => {
  const banner = el("error");
  banner.style.display = "block";
  banner.textContent = String(e?.stack || e);
  console.error(e);
});
