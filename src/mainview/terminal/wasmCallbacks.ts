/**
 * JS callbacks as C function pointers for a zero-import wasm module.
 *
 * libghostty-vt takes its "effects" (write to the pty, title changed, clipboard write, …) as C
 * function pointers, and a C function pointer in wasm is an index into the module's function
 * table. The module imports nothing, so no JS function is in that table — but it exports the table,
 * and a table accepts any wasm function reference. A helper module that only imports our JS
 * functions and re-exports them yields exactly such references; placing them in the main table
 * turns their indices into pointers `ghostty_terminal_set` accepts.
 *
 * The helper module is assembled here byte by byte (type, import and export sections only — no
 * code), so there is no toolchain and nothing to vendor.
 */

/** A callback's C signature: `params` i32 arguments, optionally one i32 result. */
export interface CallbackSignature {
  readonly params: number;
  readonly result: boolean;
}

export interface CallbackEntry {
  readonly signature: CallbackSignature;
  readonly fn: (...args: number[]) => number | undefined | void;
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_EXPORT = 7;
const FUNC_TYPE = 0x60;
const I32 = 0x7f;
const KIND_FUNC = 0x00;
const IMPORT_MODULE = "env";

function uleb(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

function name(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

const fnName = (i: number) => `f${i}`;

/**
 * A wasm module that imports `env.f0 … env.fN` with the given signatures and re-exports each under
 * the same name, and nothing else.
 */
export function trampolineModule(signatures: readonly CallbackSignature[]): ArrayBuffer {
  const types = signatures.flatMap((s) => [
    FUNC_TYPE,
    ...uleb(s.params),
    ...new Array<number>(s.params).fill(I32),
    ...(s.result ? [1, I32] : [0]),
  ]);
  const imports = signatures.flatMap((_, i) => [
    ...name(IMPORT_MODULE),
    ...name(fnName(i)),
    KIND_FUNC,
    ...uleb(i),
  ]);
  const exports = signatures.flatMap((_, i) => [...name(fnName(i)), KIND_FUNC, ...uleb(i)]);
  return new Uint8Array([
    ...MAGIC,
    ...section(SECTION_TYPE, [...uleb(signatures.length), ...types]),
    ...section(SECTION_IMPORT, [...uleb(signatures.length), ...imports]),
    ...section(SECTION_EXPORT, [...uleb(signatures.length), ...exports]),
  ]).buffer as ArrayBuffer;
}

/**
 * Places {@code entries} in {@code table} (growing it) and returns each callback's index — the
 * value to hand a C API as the function pointer.
 */
export async function installCallbacks(
  table: WebAssembly.Table,
  entries: readonly CallbackEntry[],
): Promise<number[]> {
  if (entries.length === 0) return [];
  const module = trampolineModule(entries.map((e) => e.signature));
  const env = Object.fromEntries(entries.map((e, i) => [fnName(i), e.fn]));
  const { instance } = await WebAssembly.instantiate(module, { env });
  const base = table.grow(entries.length);
  return entries.map((_, i) => {
    table.set(base + i, instance.exports[fnName(i)]);
    return base + i;
  });
}
