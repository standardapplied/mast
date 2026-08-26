/**
 * TerminalRenderer — draws a {@link GridSnapshot} onto a canvas, GPU-accelerated.
 *
 * The VT core ({@link VtCore}) owns terminal state and hands us damage-tracked rows of resolved
 * cells; this file owns pixels and nothing else. It keeps a persistent cell grid, applies only the
 * dirty rows each frame (libghostty-vt's damage is the whole point), rasterizes each grapheme once
 * into a glyph atlas, and draws the grid as instanced quads: one background quad per cell, one
 * glyph quad per non-blank cell, plus the cursor.
 *
 * Two backends implement the same {@link Backend} seam. WebGPU is the target — it maps onto Metal
 * the way native Ghostty does. WebGL2 is the fallback for webviews without `navigator.gpu`
 * (macOS < 26). The atlas, the grid model, and the instance packing are backend-agnostic and shared;
 * only the device, the shaders, and the draw call differ.
 */

import type { Cursor, GridSnapshot, Rgb } from "../vtCore";

export type BackendName = "webgpu" | "webgl2";

export interface RendererOptions {
  /** Monospace family used to rasterize glyphs; must be loaded before the first frame. */
  readonly fontFamily: string;
  /** Cell height in CSS pixels; cell width is derived from the font's advance. */
  readonly fontPx: number;
  /** Extra line height as a fraction of fontPx (0.2 ≈ comfortable). */
  readonly linePad: number;
  /** Device pixel ratio to render at (crispness on retina). */
  readonly dpr: number;
}

const WHITE: Rgb = [230, 236, 245];
const GROUND: Rgb = [11, 14, 20];

/**
 * Rasterizes graphemes into a fixed-cell atlas on an OffscreenCanvas and hands out a stable index
 * per grapheme. Glyphs are drawn in white on transparent; the renderer tints them per cell, so one
 * atlas entry serves every color the same grapheme ever appears in.
 */
class GlyphAtlas {
  readonly cellW: number;
  readonly cellH: number;
  private readonly cols: number;
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly index = new Map<string, number>();
  private readonly baseline: number;
  private next = 1; // 0 is reserved for "blank" (drawn as nothing)
  private generation = 0;

  constructor(fontFamily: string, fontPx: number, linePad: number, dpr: number) {
    const probe = new OffscreenCanvas(64, 64).getContext("2d")!;
    probe.font = `${fontPx}px ${fontFamily}`;
    const advance = probe.measureText("M").width;
    this.cellW = Math.max(1, Math.round(advance * dpr));
    this.cellH = Math.max(1, Math.round(fontPx * (1 + linePad) * dpr));
    this.baseline = Math.round(fontPx * (1 + linePad / 2) * dpr) - Math.round(fontPx * 0.2 * dpr);
    this.cols = 64;
    const rows = 64;
    this.canvas = new OffscreenCanvas(this.cols * this.cellW, rows * this.cellH);
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.textBaseline = "alphabetic";
    this.ctx.font = `${Math.round(fontPx * dpr)}px ${fontFamily}`;
    this.ctx.fillStyle = "#fff";
  }

  /** The atlas index for {@code text}; blank/space is 0. Rasterizes on first sight. */
  glyph(text: string): number {
    if (text === "" || text === " ") return 0;
    const hit = this.index.get(text);
    if (hit !== undefined) return hit;
    const id = this.next++;
    this.index.set(text, id);
    const col = id % this.cols;
    const row = Math.floor(id / this.cols);
    this.ctx.fillText(text, col * this.cellW + 1, row * this.cellH + this.baseline);
    this.generation++;
    return id;
  }

  cell(id: number): { u: number; v: number } {
    return { u: id % this.cols, v: Math.floor(id / this.cols) };
  }

  get atlasCols(): number {
    return this.cols;
  }
  get bitmap(): OffscreenCanvas {
    return this.canvas;
  }
  /** Bumps when new glyphs were rasterized, so a backend knows to re-upload the texture. */
  get version(): number {
    return this.generation;
  }
}

interface FrameData {
  readonly cols: number;
  readonly rows: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly atlasCols: number;
  /** Per-cell background: cols*rows*3 floats (0..1). */
  readonly bg: Float32Array;
  /** Per-glyph-cell foreground: packed [x,y, r,g,b, u,v] * n. */
  readonly fg: Float32Array;
  readonly fgCount: number;
  readonly atlas: OffscreenCanvas;
  readonly atlasVersion: number;
}

interface Backend {
  readonly name: BackendName;
  resize(pxW: number, pxH: number): void;
  frame(data: FrameData): void;
  destroy(): void;
}

/** One packed cell in the persistent grid model. */
interface ModelCell {
  glyph: number;
  fr: number;
  fg: number;
  fb: number;
  br: number;
  bg: number;
  bb: number;
}

export class TerminalRenderer {
  private readonly opts: RendererOptions;
  private readonly atlas: GlyphAtlas;
  private backend!: Backend;
  private model: ModelCell[] = [];
  private cols = 0;
  private rows = 0;
  private cursor: Cursor = { present: false, x: 0, y: 0, visible: false };

  private constructor(opts: RendererOptions) {
    this.opts = opts;
    this.atlas = new GlyphAtlas(opts.fontFamily, opts.fontPx, opts.linePad, opts.dpr);
  }

  /** The cell size in device pixels, so the harness can size the terminal to the canvas. */
  get cellSize(): { w: number; h: number } {
    return { w: this.atlas.cellW, h: this.atlas.cellH };
  }
  get backendName(): BackendName {
    return this.backend.name;
  }

  /**
   * Builds a renderer on {@code canvas}, choosing WebGPU when the platform offers it and falling
   * back to WebGL2 otherwise. Fails loudly only if neither is available.
   */
  static async create(canvas: HTMLCanvasElement, opts: RendererOptions): Promise<TerminalRenderer> {
    const self = new TerminalRenderer(opts);
    self.backend =
      (await WebGpuBackend.tryCreate(canvas)) ?? WebGl2Backend.create(canvas);
    return self;
  }

  /** Resizes the render surface and the grid to {@code cols}×{@code rows}. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.model = Array.from({ length: cols * rows }, () => ({
      glyph: 0,
      fr: 0,
      fg: 0,
      fb: 0,
      br: 0,
      bg: 0,
      bb: 0,
    }));
    this.backend.resize(cols * this.atlas.cellW, rows * this.atlas.cellH);
  }

  /** Folds a snapshot's dirty rows into the grid model. Cheap: only changed rows are touched. */
  apply(snapshot: GridSnapshot): void {
    for (const row of snapshot.rows) {
      if (row.y < 0 || row.y >= this.rows) continue;
      for (let x = 0; x < row.cells.length && x < this.cols; x++) {
        const c = row.cells[x];
        const m = this.model[row.y * this.cols + x];
        m.glyph = this.atlas.glyph(c.text);
        m.fr = c.fg[0];
        m.fg = c.fg[1];
        m.fb = c.fg[2];
        m.br = c.bg[0];
        m.bg = c.bg[1];
        m.bb = c.bg[2];
      }
    }
  }

  setCursor(cursor: Cursor): void {
    this.cursor = cursor;
  }

  /** Packs the current grid model into instance buffers and draws one frame. */
  draw(): void {
    const n = this.cols * this.rows;
    const bg = new Float32Array(n * 3);
    const fg = new Float32Array(n * 7);
    let fgCount = 0;

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const m = this.model[y * this.cols + x];
        const onCursor =
          this.cursor.present && this.cursor.visible && this.cursor.x === x && this.cursor.y === y;
        const bi = (y * this.cols + x) * 3;
        if (onCursor) {
          bg[bi] = WHITE[0] / 255;
          bg[bi + 1] = WHITE[1] / 255;
          bg[bi + 2] = WHITE[2] / 255;
        } else {
          bg[bi] = m.br / 255;
          bg[bi + 1] = m.bg / 255;
          bg[bi + 2] = m.bb / 255;
        }
        if (m.glyph !== 0) {
          const { u, v } = this.atlas.cell(m.glyph);
          const o = fgCount * 7;
          fg[o] = x;
          fg[o + 1] = y;
          if (onCursor) {
            fg[o + 2] = GROUND[0] / 255;
            fg[o + 3] = GROUND[1] / 255;
            fg[o + 4] = GROUND[2] / 255;
          } else {
            fg[o + 2] = m.fr / 255;
            fg[o + 3] = m.fg / 255;
            fg[o + 4] = m.fb / 255;
          }
          fg[o + 5] = u;
          fg[o + 6] = v;
          fgCount++;
        }
      }
    }

    this.backend.frame({
      cols: this.cols,
      rows: this.rows,
      cellW: this.atlas.cellW,
      cellH: this.atlas.cellH,
      atlasCols: this.atlas.atlasCols,
      bg,
      fg,
      fgCount,
      atlas: this.atlas.bitmap,
      atlasVersion: this.atlas.version,
    });
  }

  destroy(): void {
    this.backend.destroy();
  }
}

// ── WebGPU ──────────────────────────────────────────────────────────────────

const WGSL = /* wgsl */ `
struct Uniforms {
  view : vec2f,      // canvas size in px
  cell : vec2f,      // cell size in px
  atlas : vec2f,     // atlas grid cols, and atlas texel size flag (cols only used)
  pad : vec2f,
};
@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var atlasTex : texture_2d<f32>;
@group(0) @binding(2) var atlasSamp : sampler;

struct BgOut { @builtin(position) pos : vec4f, @location(0) color : vec3f, };

@vertex
fn bg_vs(@builtin(vertex_index) vi : u32,
         @location(0) grid : vec2f,
         @location(1) color : vec3f) -> BgOut {
  var corners = array<vec2f,6>(
    vec2f(0,0), vec2f(1,0), vec2f(0,1),
    vec2f(0,1), vec2f(1,0), vec2f(1,1));
  let c = corners[vi];
  let px = (grid + c) * U.cell;
  let ndc = vec2f(px.x / U.view.x * 2.0 - 1.0, 1.0 - px.y / U.view.y * 2.0);
  var o : BgOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.color = color;
  return o;
}

@fragment
fn bg_fs(i : BgOut) -> @location(0) vec4f { return vec4f(i.color, 1.0); }

struct FgOut { @builtin(position) pos : vec4f, @location(0) color : vec3f, @location(1) uv : vec2f, };

@vertex
fn fg_vs(@builtin(vertex_index) vi : u32,
         @location(0) grid : vec2f,
         @location(1) color : vec3f,
         @location(2) atlasCell : vec2f) -> FgOut {
  var corners = array<vec2f,6>(
    vec2f(0,0), vec2f(1,0), vec2f(0,1),
    vec2f(0,1), vec2f(1,0), vec2f(1,1));
  let c = corners[vi];
  let px = (grid + c) * U.cell;
  let ndc = vec2f(px.x / U.view.x * 2.0 - 1.0, 1.0 - px.y / U.view.y * 2.0);
  let uv = (atlasCell + c) / vec2f(U.atlas.x, U.atlas.x);
  var o : FgOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.color = color;
  o.uv = uv;
  return o;
}

@fragment
fn fg_fs(i : FgOut) -> @location(0) vec4f {
  let a = textureSample(atlasTex, atlasSamp, i.uv).a;
  return vec4f(i.color, a);
}
`;

class WebGpuBackend implements Backend {
  readonly name = "webgpu" as const;
  private uploadedAtlas = -1;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
    private readonly ctx: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private readonly bgPipe: GPURenderPipeline,
    private readonly fgPipe: GPURenderPipeline,
    private readonly sampler: GPUSampler,
    private readonly bindLayout: GPUBindGroupLayout,
  ) {}

  private uniform!: GPUBuffer;
  private texture!: GPUTexture;
  private bind!: GPUBindGroup;

  static async tryCreate(canvas: HTMLCanvasElement): Promise<WebGpuBackend | null> {
    const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!ctx) return null;
    const format = gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: "opaque" });

    const module = device.createShaderModule({ code: WGSL });
    // One explicit layout shared by both pipelines: the background pipeline only
    // reads the uniform, but sharing the layout lets a single bind group serve
    // both draws. (With "auto", each pipeline derives a different layout and a
    // bind group built for one is invalid for the other.)
    const bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    const blend: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const bgPipe = device.createRenderPipeline({
      layout,
      vertex: {
        module,
        entryPoint: "bg_vs",
        buffers: [
          {
            arrayStride: 5 * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 2 * 4, format: "float32x3" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "bg_fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const fgPipe = device.createRenderPipeline({
      layout,
      vertex: {
        module,
        entryPoint: "fg_vs",
        buffers: [
          {
            arrayStride: 7 * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 2 * 4, format: "float32x3" },
              { shaderLocation: 2, offset: 5 * 4, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fg_fs", targets: [{ format, blend }] },
      primitive: { topology: "triangle-list" },
    });
    // Nearest, not linear: the atlas is rasterized at the exact device-pixel cell
    // size and blitted 1:1, so nearest is crisp AND never samples across a cell
    // boundary into a neighbouring glyph (the source of edge-bleed dots).
    const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    return new WebGpuBackend(canvas, device, ctx, format, bgPipe, fgPipe, sampler, bindLayout);
  }

  resize(pxW: number, pxH: number): void {
    this.canvas.width = pxW;
    this.canvas.height = pxH;
  }

  private ensureAtlas(atlas: OffscreenCanvas, version: number): void {
    if (
      !this.texture ||
      this.texture.width !== atlas.width ||
      this.texture.height !== atlas.height
    ) {
      this.texture?.destroy();
      this.texture = this.device.createTexture({
        size: [atlas.width, atlas.height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.uploadedAtlas = -1;
    }
    if (this.uploadedAtlas !== version) {
      this.device.queue.copyExternalImageToTexture(
        { source: atlas },
        { texture: this.texture },
        [atlas.width, atlas.height],
      );
      this.uploadedAtlas = version;
    }
    if (!this.uniform) {
      this.uniform = this.device.createBuffer({
        size: 8 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    this.bind = this.device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  frame(d: FrameData): void {
    this.ensureAtlas(d.atlas, d.atlasVersion);
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([
        this.canvas.width,
        this.canvas.height,
        d.cellW,
        d.cellH,
        d.atlasCols,
        0,
        0,
        0,
      ]),
    );

    const gridBg = new Float32Array(d.cols * d.rows * 5);
    for (let y = 0; y < d.rows; y++) {
      for (let x = 0; x < d.cols; x++) {
        const i = (y * d.cols + x) * 5;
        const c = (y * d.cols + x) * 3;
        gridBg[i] = x;
        gridBg[i + 1] = y;
        gridBg[i + 2] = d.bg[c];
        gridBg[i + 3] = d.bg[c + 1];
        gridBg[i + 4] = d.bg[c + 2];
      }
    }
    const bgBuf = this.device.createBuffer({
      size: gridBg.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(bgBuf, 0, gridBg);

    const fgBuf = this.device.createBuffer({
      size: Math.max(28, d.fg.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (d.fgCount > 0) this.device.queue.writeBuffer(fgBuf, 0, d.fg.subarray(0, d.fgCount * 7));

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: 11 / 255, g: 14 / 255, b: 20 / 255, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setBindGroup(0, this.bind);
    pass.setPipeline(this.bgPipe);
    pass.setVertexBuffer(0, bgBuf);
    pass.draw(6, d.cols * d.rows);
    if (d.fgCount > 0) {
      pass.setPipeline(this.fgPipe);
      pass.setVertexBuffer(0, fgBuf);
      pass.draw(6, d.fgCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    bgBuf.destroy();
    fgBuf.destroy();
  }

  destroy(): void {
    this.texture?.destroy();
    this.device.destroy();
  }
}

// ── WebGL2 fallback ──────────────────────────────────────────────────────────

const GL_BG_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 grid;
layout(location=1) in vec3 color;
uniform vec2 uView; uniform vec2 uCell;
out vec3 vColor;
const vec2 C[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
void main(){
  vec2 px = (grid + C[gl_VertexID]) * uCell;
  gl_Position = vec4(px.x/uView.x*2.0-1.0, 1.0-px.y/uView.y*2.0, 0.0, 1.0);
  vColor = color;
}`;
const GL_BG_FS = `#version 300 es
precision highp float; in vec3 vColor; out vec4 o; void main(){ o = vec4(vColor,1.0); }`;
const GL_FG_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 grid;
layout(location=1) in vec3 color;
layout(location=2) in vec2 atlasCell;
uniform vec2 uView; uniform vec2 uCell; uniform float uAtlasCols;
out vec3 vColor; out vec2 vUv;
const vec2 C[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
void main(){
  vec2 c = C[gl_VertexID];
  vec2 px = (grid + c) * uCell;
  gl_Position = vec4(px.x/uView.x*2.0-1.0, 1.0-px.y/uView.y*2.0, 0.0, 1.0);
  vUv = (atlasCell + c) / vec2(uAtlasCols, uAtlasCols);
  vColor = color;
}`;
const GL_FG_FS = `#version 300 es
precision highp float; in vec3 vColor; in vec2 vUv; uniform sampler2D uAtlas; out vec4 o;
void main(){ float a = texture(uAtlas, vUv).a; o = vec4(vColor, a); }`;

class WebGl2Backend implements Backend {
  readonly name = "webgl2" as const;
  private uploadedAtlas = -1;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly bgProg: WebGLProgram,
    private readonly fgProg: WebGLProgram,
    private readonly bgBuf: WebGLBuffer,
    private readonly fgBuf: WebGLBuffer,
    private readonly bgVao: WebGLVertexArrayObject,
    private readonly fgVao: WebGLVertexArrayObject,
    private readonly tex: WebGLTexture,
  ) {}

  static create(canvas: HTMLCanvasElement): WebGl2Backend {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) throw new Error("TerminalRenderer: neither WebGPU nor WebGL2 is available.");
    const bgProg = link(gl, GL_BG_VS, GL_BG_FS);
    const fgProg = link(gl, GL_FG_VS, GL_FG_FS);
    const bgBuf = gl.createBuffer()!;
    const fgBuf = gl.createBuffer()!;
    const bgVao = gl.createVertexArray()!;
    gl.bindVertexArray(bgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
    attr(gl, 0, 2, 5 * 4, 0);
    attr(gl, 1, 3, 5 * 4, 2 * 4);
    const fgVao = gl.createVertexArray()!;
    gl.bindVertexArray(fgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, fgBuf);
    attr(gl, 0, 2, 7 * 4, 0);
    attr(gl, 1, 3, 7 * 4, 2 * 4);
    attr(gl, 2, 2, 7 * 4, 5 * 4);
    gl.bindVertexArray(null);
    const tex = gl.createTexture()!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return new WebGl2Backend(canvas, gl, bgProg, fgProg, bgBuf, fgBuf, bgVao, fgVao, tex);
  }

  resize(pxW: number, pxH: number): void {
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.gl.viewport(0, 0, pxW, pxH);
  }

  frame(d: FrameData): void {
    const gl = this.gl;
    if (this.uploadedAtlas !== d.atlasVersion) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, d.atlas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.uploadedAtlas = d.atlasVersion;
    }

    gl.clearColor(11 / 255, 14 / 255, 20 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const gridBg = new Float32Array(d.cols * d.rows * 5);
    for (let y = 0; y < d.rows; y++) {
      for (let x = 0; x < d.cols; x++) {
        const i = (y * d.cols + x) * 5;
        const c = (y * d.cols + x) * 3;
        gridBg[i] = x;
        gridBg[i + 1] = y;
        gridBg[i + 2] = d.bg[c];
        gridBg[i + 3] = d.bg[c + 1];
        gridBg[i + 4] = d.bg[c + 2];
      }
    }

    gl.useProgram(this.bgProg);
    uni2(gl, this.bgProg, "uView", this.canvas.width, this.canvas.height);
    uni2(gl, this.bgProg, "uCell", d.cellW, d.cellH);
    gl.bindVertexArray(this.bgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, gridBg, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, d.cols * d.rows);

    if (d.fgCount > 0) {
      gl.useProgram(this.fgProg);
      uni2(gl, this.fgProg, "uView", this.canvas.width, this.canvas.height);
      uni2(gl, this.fgProg, "uCell", d.cellW, d.cellH);
      gl.uniform1f(gl.getUniformLocation(this.fgProg, "uAtlasCols"), d.atlasCols);
      gl.uniform1i(gl.getUniformLocation(this.fgProg, "uAtlas"), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.bindVertexArray(this.fgVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fgBuf);
      gl.bufferData(gl.ARRAY_BUFFER, d.fg.subarray(0, d.fgCount * 7), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, d.fgCount);
    }
    gl.bindVertexArray(null);
  }

  destroy(): void {
    const l = this.gl.getExtension("WEBGL_lose_context");
    l?.loseContext();
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function attr(
  gl: WebGL2RenderingContext,
  loc: number,
  size: number,
  stride: number,
  offset: number,
): void {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(loc, 1);
}

function uni2(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, a: number, b: number) {
  gl.uniform2f(gl.getUniformLocation(prog, name), a, b);
}
