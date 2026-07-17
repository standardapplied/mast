/**
 * Viewer routing, pure: file name + size → how to render, before any bytes
 * move. `sniff` means "fetch and NUL-check, then text or fallback". Never a
 * broken render: anything unrecognized lands on the metadata card, not a
 * garbled pane.
 */

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type FallbackReason = "too-large" | "binary" | "unknown";

export type FileRoute =
  | { kind: "code"; language: string | null; markdown: boolean }
  | { kind: "image"; mime: string }
  | { kind: "pdf" }
  | { kind: "gpointer" }
  | { kind: "sniff" }
  | { kind: "fallback"; reason: FallbackReason };

const LANGUAGES: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  rs: "rust",
  java: "java",
  css: "css",
  html: "html",
  htm: "html",
};

const TEXT_EXTENSIONS = new Set([
  ...Object.keys(LANGUAGES),
  "toml", "sh", "bash", "zsh", "fish", "txt", "text", "log", "xml", "ini", "cfg", "conf",
  "env", "lock", "sql", "graphql", "proto", "csv", "tsv", "diff", "patch",
]);

const IMAGE_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const BINARY_EXTENSIONS = new Set([
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
  "exe", "dll", "so", "dylib", "bin", "dmg", "iso", "o", "a", "wasm", "class", "pyc",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "m4a", "mov", "avi", "mkv", "wav", "flac", "ogg", "webm",
  "db", "sqlite", "sqlite3", "ico", "icns", "heic", "bmp", "tiff",
]);

function extension(name: string): string | null {
  const cut = name.lastIndexOf(".");
  if (cut <= 0 || cut === name.length - 1) return null;
  return name.slice(cut + 1).toLowerCase();
}

export function languageFor(name: string): string | null {
  const ext = extension(name);
  return (ext && LANGUAGES[ext]) || null;
}

export function routeFile(name: string, size: number): FileRoute {
  const ext = extension(name);
  if (ext && IMAGE_MIMES[ext]) return { kind: "image", mime: IMAGE_MIMES[ext] };
  if (ext === "pdf") return { kind: "pdf" };
  if (ext === "gdoc" || ext === "gsheet" || ext === "gslides") return { kind: "gpointer" };
  if (ext && BINARY_EXTENSIONS.has(ext)) return { kind: "fallback", reason: "binary" };
  if (size > MAX_TEXT_BYTES) return { kind: "fallback", reason: "too-large" };
  if (ext && TEXT_EXTENSIONS.has(ext)) {
    const language = LANGUAGES[ext] ?? null;
    return { kind: "code", language, markdown: language === "markdown" };
  }
  return { kind: "sniff" };
}

export function sniffBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}
