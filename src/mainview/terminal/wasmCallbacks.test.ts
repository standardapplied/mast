import { describe, expect, test } from "bun:test";
import { installCallbacks, trampolineModule } from "./wasmCallbacks";

describe("trampolineModule", () => {
  test("assembles a valid module for any mix of signatures", () => {
    expect(WebAssembly.validate(trampolineModule([]))).toBe(true);
    expect(WebAssembly.validate(trampolineModule([{ params: 4, result: false }]))).toBe(true);
    expect(
      WebAssembly.validate(
        trampolineModule([
          { params: 2, result: false },
          { params: 3, result: true },
          { params: 0, result: true },
        ]),
      ),
    ).toBe(true);
  });

  test("imports env.fN and re-exports fN, and nothing more", () => {
    const module = new WebAssembly.Module(
      trampolineModule([
        { params: 2, result: false },
        { params: 1, result: true },
      ]),
    );
    expect(
      WebAssembly.Module.imports(module).map(({ module: m, name, kind }) => ({ module: m, name, kind })),
    ).toEqual([
      { module: "env", name: "f0", kind: "function" },
      { module: "env", name: "f1", kind: "function" },
    ]);
    expect(WebAssembly.Module.exports(module).map((e) => e.name)).toEqual(["f0", "f1"]);
  });
});

describe("installCallbacks", () => {
  test("a JS function becomes a table index that wasm-side calls reach with its arguments", async () => {
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 3 });
    const seen: number[][] = [];
    const [a, b] = await installCallbacks(table, [
      { signature: { params: 3, result: false }, fn: (...args) => void seen.push(args) },
      { signature: { params: 2, result: true }, fn: (x, y) => x! * 10 + y! },
    ]);
    expect([a, b]).toEqual([3, 4]);
    expect(table.length).toBe(5);
    (table.get(a) as (x: number, y: number, z: number) => void)(7, 8, 9);
    expect(seen).toEqual([[7, 8, 9]]);
    expect((table.get(b) as (x: number, y: number) => number)(4, 2)).toBe(42);
  });

  test("installing nothing touches nothing", async () => {
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
    expect(await installCallbacks(table, [])).toEqual([]);
    expect(table.length).toBe(1);
  });
});
