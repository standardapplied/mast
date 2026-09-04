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

import { BG_STRIDE, FG_PER_CELL, FG_STRIDE, packFrame } from "./framePacker";
import { GlyphAtlas } from "./glyphAtlas";
import { offscreenRaster, type RasterFactory } from "./raster";
import type { Selection } from "./selection";
import type { Renderer } from "./terminalController";
import { TerminalGrid } from "./terminalGrid";
import type { Cursor, GridSnapshot, Rgb } from "./vtCore";

export type BackendName = "webgpu" | "webgl2";

export interface RendererOptions {
  /** Monospace family used to rasterize glyphs; must be loaded before the first frame. */
  readonly fontFamily: string;
  /** Font size in CSS pixels; the cell is derived from the face's metrics (see fontMetrics.ts). */
  readonly fontPx: number;
  /** Device pixel ratio to render at (crispness on retina). */
  readonly dpr: number;
  /** Theme background — the canvas clear and the color drawn under the block cursor. */
  readonly bg: Rgb;
  /** Theme foreground — blank cells; default-colored text already arrives resolved from VtCore. */
  readonly fg: Rgb;
  /** Block-cursor color. */
  readonly cursor: Rgb;
  /** Selection highlight background and the text color drawn over it. */
  readonly selectionBg: Rgb;
  readonly selectionFg: Rgb;
  /** Reports an async GPU error (uncaptured validation error, device loss) that no throw surfaces. */
  readonly onError?: (message: string) => void;
  /** Where the glyph atlas draws; defaults to an OffscreenCanvas. */
  readonly raster?: RasterFactory;
}

interface FrameData {
  readonly cols: number;
  readonly rows: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly atlasCols: number;
  /** Per-cell background, row-major: cols*rows*BG_STRIDE floats (0..1). */
  readonly bg: Float32Array;
  /** Per-glyph-cell foreground: packed [x,y, r,g,b, u,v, w, mode] * n. */
  readonly fg: Float32Array;
  readonly fgCount: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  /** The atlas bitmap's pixels, read when {@link atlasVersion} changed. */
  readonly atlasPixels: () => Uint8ClampedArray;
  readonly atlasVersion: number;
  /** Canvas clear color (theme background). */
  readonly clear: Rgb;
}

interface Backend {
  readonly name: BackendName;
  resize(pxW: number, pxH: number): void;
  frame(data: FrameData): void;
  destroy(): void;
}

export class TerminalRenderer implements Renderer {
  private readonly opts: RendererOptions;
  private readonly atlas: GlyphAtlas;
  private backend!: Backend;
  private readonly grid: TerminalGrid;
  private cols = 0;
  private rows = 0;
  private cursor: Cursor = {
    present: false,
    x: 0,
    y: 0,
    visible: false,
    style: "block",
    blinking: false,
  };
  private selection: Selection | null = null;
  // Instance buffers reused across frames — sized on resize, never per frame.
  private bgInstances = new Float32Array(0);
  private fgInstances = new Float32Array(0);

  private constructor(opts: RendererOptions) {
    this.opts = opts;
    this.atlas = new GlyphAtlas(opts.raster ?? offscreenRaster, opts.fontFamily, opts.fontPx, opts.dpr);
    this.grid = new TerminalGrid({ fg: opts.fg, bg: opts.bg });
  }

  /** The cell size in device pixels, so the harness can size the terminal to the canvas. */
  get cellSize(): { w: number; h: number } {
    return { w: this.atlas.metrics.cellW, h: this.atlas.metrics.cellH };
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
      (await WebGpuBackend.tryCreate(canvas, opts.onError)) ?? WebGl2Backend.create(canvas);
    return self;
  }

  /** Resizes the render surface and the grid to {@code cols}×{@code rows}. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.grid.resize(cols, rows);
    this.bgInstances = new Float32Array(cols * rows * BG_STRIDE);
    this.fgInstances = new Float32Array((cols * rows * FG_PER_CELL + 1) * FG_STRIDE);
    this.backend.resize(cols * this.atlas.metrics.cellW, rows * this.atlas.metrics.cellH);
  }

  /** Folds a snapshot's rows into the grid. Cheap on a dirty snapshot: only changed rows are touched. */
  apply(snapshot: GridSnapshot): void {
    this.grid.apply(snapshot);
  }

  setCursor(cursor: Cursor): void {
    this.cursor = cursor;
  }

  setSelection(selection: Selection | null): void {
    this.selection = selection;
  }

  /** Packs the current grid into the reused instance buffers and draws one frame. */
  draw(): void {
    const bg = this.bgInstances;
    const fg = this.fgInstances;
    const fgCount = packFrame(this.grid, this.cursor, this.selection, this.atlas, this.opts, {
      bg,
      fg,
    });

    this.backend.frame({
      cols: this.cols,
      rows: this.rows,
      cellW: this.atlas.metrics.cellW,
      cellH: this.atlas.metrics.cellH,
      atlasCols: this.atlas.atlasCols,
      bg,
      fg,
      fgCount,
      atlasWidth: this.atlas.width,
      atlasHeight: this.atlas.height,
      atlasPixels: () => this.atlas.pixels(),
      atlasVersion: this.atlas.version,
      clear: this.opts.bg,
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
  atlas : vec2f,     // x: atlas grid cols
  grid : vec2f,      // x: terminal cols (background instances index the grid row-major)
};
@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var atlasTex : texture_2d<f32>;
@group(0) @binding(2) var atlasSamp : sampler;

struct BgOut { @builtin(position) pos : vec4f, @location(0) color : vec3f, };

@vertex
fn bg_vs(@builtin(vertex_index) vi : u32,
         @builtin(instance_index) ii : u32,
         @location(0) color : vec3f) -> BgOut {
  var corners = array<vec2f,6>(
    vec2f(0,0), vec2f(1,0), vec2f(0,1),
    vec2f(0,1), vec2f(1,0), vec2f(1,1));
  let c = corners[vi];
  let cols = u32(U.grid.x);
  let grid = vec2f(f32(ii % cols), f32(ii / cols));
  let px = (grid + c) * U.cell;
  let ndc = vec2f(px.x / U.view.x * 2.0 - 1.0, 1.0 - px.y / U.view.y * 2.0);
  var o : BgOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.color = color;
  return o;
}

@fragment
fn bg_fs(i : BgOut) -> @location(0) vec4f { return vec4f(i.color, 1.0); }

struct FgOut {
  @builtin(position) pos : vec4f,
  @location(0) color : vec3f,
  @location(1) uv : vec2f,
  @location(2) @interpolate(flat) mode : u32,
};

@vertex
fn fg_vs(@builtin(vertex_index) vi : u32,
         @location(0) grid : vec2f,
         @location(1) color : vec3f,
         @location(2) atlasCell : vec2f,
         @location(3) w : f32,
         @location(4) mode : f32) -> FgOut {
  var corners = array<vec2f,6>(
    vec2f(0,0), vec2f(1,0), vec2f(0,1),
    vec2f(0,1), vec2f(1,0), vec2f(1,1));
  let base = corners[vi];
  let c = vec2f(base.x * w, base.y); // a wide glyph spans w cells in x, sampling w atlas cells
  let px = (grid + c) * U.cell;
  let ndc = vec2f(px.x / U.view.x * 2.0 - 1.0, 1.0 - px.y / U.view.y * 2.0);
  let uv = (atlasCell + c) / vec2f(U.atlas.x, U.atlas.x);
  var o : FgOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.color = color;
  o.uv = uv;
  o.mode = u32(mode);
  return o;
}

@fragment
fn fg_fs(i : FgOut) -> @location(0) vec4f {
  let t = textureSample(atlasTex, atlasSamp, i.uv);
  // mode 0 tints the white mask with the cell color; mode 1 draws a color glyph as-is.
  return select(vec4f(i.color, t.a), t, i.mode == 1u);
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

  static async tryCreate(
    canvas: HTMLCanvasElement,
    onError?: (message: string) => void,
  ): Promise<WebGpuBackend | null> {
    const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    if (onError) {
      device.addEventListener("uncapturederror", (event) => {
        onError(`GPU error: ${(event as GPUUncapturedErrorEvent).error.message}`);
      });
      void device.lost.then((info) => onError(`GPU device lost: ${info.message}`));
    }
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
            arrayStride: BG_STRIDE * 4,
            stepMode: "instance",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
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
            arrayStride: FG_STRIDE * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 2 * 4, format: "float32x3" },
              { shaderLocation: 2, offset: 5 * 4, format: "float32x2" },
              { shaderLocation: 3, offset: 7 * 4, format: "float32" },
              { shaderLocation: 4, offset: 8 * 4, format: "float32" },
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

  private bgBuf: GPUBuffer | null = null;
  private fgBuf: GPUBuffer | null = null;

  resize(pxW: number, pxH: number): void {
    this.canvas.width = pxW;
    this.canvas.height = pxH;
  }

  /** Vertex buffers persist across frames and grow only when the grid outgrows them. */
  private vertexBuffer(current: GPUBuffer | null, bytes: number): GPUBuffer {
    if (current && current.size >= bytes) return current;
    current?.destroy();
    return this.device.createBuffer({
      size: Math.max(4, bytes),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  private ensureAtlas(d: FrameData): void {
    if (
      !this.texture ||
      this.texture.width !== d.atlasWidth ||
      this.texture.height !== d.atlasHeight
    ) {
      this.texture?.destroy();
      this.texture = this.device.createTexture({
        size: [d.atlasWidth, d.atlasHeight],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.uploadedAtlas = -1;
    }
    if (this.uploadedAtlas !== d.atlasVersion) {
      const pixels = d.atlasPixels();
      this.device.queue.writeTexture(
        { texture: this.texture },
        pixels.buffer as ArrayBuffer,
        { offset: pixels.byteOffset, bytesPerRow: d.atlasWidth * 4, rowsPerImage: d.atlasHeight },
        { width: d.atlasWidth, height: d.atlasHeight },
      );
      this.uploadedAtlas = d.atlasVersion;
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

  // ES2023 types Float32Array over ArrayBufferLike, which writeBuffer rejects; pass the
  // (never-shared) backing buffer with an explicit byte range instead.
  private writeF32(buffer: GPUBuffer, data: Float32Array): void {
    this.device.queue.writeBuffer(
      buffer,
      0,
      data.buffer as ArrayBuffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  frame(d: FrameData): void {
    this.ensureAtlas(d);
    this.writeF32(
      this.uniform,
      new Float32Array([
        this.canvas.width,
        this.canvas.height,
        d.cellW,
        d.cellH,
        d.atlasCols,
        0,
        d.cols,
        0,
      ]),
    );

    const bgBytes = d.cols * d.rows * BG_STRIDE * 4;
    this.bgBuf = this.vertexBuffer(this.bgBuf, bgBytes);
    this.writeF32(this.bgBuf, d.bg.subarray(0, d.cols * d.rows * BG_STRIDE));
    this.fgBuf = this.vertexBuffer(this.fgBuf, d.fg.byteLength);
    if (d.fgCount > 0) this.writeF32(this.fgBuf, d.fg.subarray(0, d.fgCount * FG_STRIDE));
    const bgBuf = this.bgBuf;
    const fgBuf = this.fgBuf;

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: d.clear[0] / 255, g: d.clear[1] / 255, b: d.clear[2] / 255, a: 1 },
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
  }

  destroy(): void {
    this.bgBuf?.destroy();
    this.fgBuf?.destroy();
    this.texture?.destroy();
    this.device.destroy();
  }
}

// ── WebGL2 fallback ──────────────────────────────────────────────────────────

const GL_BG_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 color;
uniform vec2 uView; uniform vec2 uCell; uniform int uCols;
out vec3 vColor;
const vec2 C[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
void main(){
  vec2 grid = vec2(float(gl_InstanceID % uCols), float(gl_InstanceID / uCols));
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
layout(location=3) in float w;
layout(location=4) in float mode;
uniform vec2 uView; uniform vec2 uCell; uniform float uAtlasCols;
out vec3 vColor; out vec2 vUv; flat out float vMode;
const vec2 C[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
void main(){
  vec2 c = vec2(C[gl_VertexID].x * w, C[gl_VertexID].y); // wide glyph spans w cells
  vec2 px = (grid + c) * uCell;
  gl_Position = vec4(px.x/uView.x*2.0-1.0, 1.0-px.y/uView.y*2.0, 0.0, 1.0);
  vUv = (atlasCell + c) / vec2(uAtlasCols, uAtlasCols);
  vColor = color;
  vMode = mode;
}`;
const GL_FG_FS = `#version 300 es
precision highp float; in vec3 vColor; in vec2 vUv; flat in float vMode; uniform sampler2D uAtlas; out vec4 o;
void main(){ vec4 t = texture(uAtlas, vUv); o = vMode > 0.5 ? t : vec4(vColor, t.a); }`;

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
    attr(gl, 0, 3, BG_STRIDE * 4, 0);
    const fgVao = gl.createVertexArray()!;
    gl.bindVertexArray(fgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, fgBuf);
    attr(gl, 0, 2, FG_STRIDE * 4, 0);
    attr(gl, 1, 3, FG_STRIDE * 4, 2 * 4);
    attr(gl, 2, 2, FG_STRIDE * 4, 5 * 4);
    attr(gl, 3, 1, FG_STRIDE * 4, 7 * 4);
    attr(gl, 4, 1, FG_STRIDE * 4, 8 * 4);
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
      const pixels = d.atlasPixels();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        d.atlasWidth,
        d.atlasHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.uploadedAtlas = d.atlasVersion;
    }

    gl.clearColor(d.clear[0] / 255, d.clear[1] / 255, d.clear[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.bgProg);
    uni2(gl, this.bgProg, "uView", this.canvas.width, this.canvas.height);
    uni2(gl, this.bgProg, "uCell", d.cellW, d.cellH);
    gl.uniform1i(gl.getUniformLocation(this.bgProg, "uCols"), d.cols);
    gl.bindVertexArray(this.bgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.bg.subarray(0, d.cols * d.rows * BG_STRIDE), gl.DYNAMIC_DRAW);
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
      gl.bufferData(gl.ARRAY_BUFFER, d.fg.subarray(0, d.fgCount * FG_STRIDE), gl.DYNAMIC_DRAW);
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
