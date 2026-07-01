/**
 * A new window/popup request is only ever allowed to open in the user's real
 * browser when it targets http(s). Everything else (file:, javascript:, custom
 * schemes, malformed URLs) is blocked — the app never spawns child webviews for
 * untrusted navigations. Kept pure so it is unit-testable without a webview.
 */
export function isExternalHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** Extracts the URL from Electrobun's `new-window-open` event detail. */
export function newWindowUrl(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "url" in detail) {
    const url = (detail as { url: unknown }).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}
