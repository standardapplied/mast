import { describe, expect, test } from "bun:test";
import { languageFor, MAX_TEXT_BYTES, routeFile, sniffBinary } from "./fileKind";

describe("routeFile", () => {
  test("known text extensions route to code with a language", () => {
    expect(routeFile("main.ts", 100)).toEqual({ kind: "code", language: "typescript", markdown: false });
    expect(routeFile("app.tsx", 100)).toEqual({ kind: "code", language: "tsx", markdown: false });
    expect(routeFile("conf.yaml", 100)).toEqual({ kind: "code", language: "yaml", markdown: false });
    expect(routeFile("Cargo.toml", 100)).toEqual({ kind: "code", language: null, markdown: false });
    expect(routeFile("run.sh", 100)).toEqual({ kind: "code", language: null, markdown: false });
  });

  test("markdown routes to code flagged for preview", () => {
    expect(routeFile("README.md", 100)).toEqual({ kind: "code", language: "markdown", markdown: true });
  });

  test("extensionless and dotfiles sniff before deciding", () => {
    expect(routeFile("Makefile", 100)).toEqual({ kind: "sniff" });
    expect(routeFile(".gitignore", 100)).toEqual({ kind: "sniff" });
  });

  test("unknown extensions sniff too", () => {
    expect(routeFile("data.xyz", 100)).toEqual({ kind: "sniff" });
  });

  test("images route by extension with a mime", () => {
    expect(routeFile("shot.png", 100)).toEqual({ kind: "image", mime: "image/png" });
    expect(routeFile("pic.JPG", 100)).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(routeFile("anim.gif", 100)).toEqual({ kind: "image", mime: "image/gif" });
    expect(routeFile("v.webp", 100)).toEqual({ kind: "image", mime: "image/webp" });
    expect(routeFile("logo.svg", 100)).toEqual({ kind: "image", mime: "image/svg+xml" });
  });

  test("pdf routes to the native embed", () => {
    expect(routeFile("paper.pdf", 100)).toEqual({ kind: "pdf" });
  });

  test("google pointers route to the browser opener", () => {
    expect(routeFile("plan.gdoc", 100)).toEqual({ kind: "gpointer" });
    expect(routeFile("nums.gsheet", 100)).toEqual({ kind: "gpointer" });
  });

  test("known binary extensions fall back without fetching", () => {
    expect(routeFile("report.docx", 100)).toEqual({ kind: "fallback", reason: "binary" });
    expect(routeFile("bundle.zip", 100)).toEqual({ kind: "fallback", reason: "binary" });
  });

  test("oversize text and sniff candidates fall back as too-large", () => {
    expect(routeFile("big.ts", MAX_TEXT_BYTES + 1)).toEqual({ kind: "fallback", reason: "too-large" });
    expect(routeFile("blob.xyz", MAX_TEXT_BYTES + 1)).toEqual({ kind: "fallback", reason: "too-large" });
  });

  test("images and pdfs are not capped at the text limit", () => {
    expect(routeFile("huge.png", MAX_TEXT_BYTES + 1).kind).toBe("image");
    expect(routeFile("huge.pdf", MAX_TEXT_BYTES + 1).kind).toBe("pdf");
  });
});

describe("languageFor", () => {
  test("maps the approved language family", () => {
    expect(languageFor("a.js")).toBe("javascript");
    expect(languageFor("a.jsx")).toBe("jsx");
    expect(languageFor("a.py")).toBe("python");
    expect(languageFor("a.rs")).toBe("rust");
    expect(languageFor("a.java")).toBe("java");
    expect(languageFor("a.css")).toBe("css");
    expect(languageFor("a.html")).toBe("html");
    expect(languageFor("a.json")).toBe("json");
    expect(languageFor("a.weird")).toBeNull();
  });
});

describe("sniffBinary", () => {
  test("a NUL byte marks binary; plain text passes", () => {
    expect(sniffBinary(new Uint8Array([104, 105, 0, 33]))).toBe(true);
    expect(sniffBinary(new TextEncoder().encode("hello\nworld"))).toBe(false);
    expect(sniffBinary(new Uint8Array())).toBe(false);
  });
});
