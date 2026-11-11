import { logError } from "./errorLog";

/**
 * Every link in the app leaves it: a click on any anchor opens its address through `openUrl` (the
 * core's `open_url`, which admits http, https and mailto) and never navigates the webview, whose
 * page holds every live session. One listener for the whole document, so no surface can forget.
 */
export function openLinksOutside(
  root: Document,
  openUrl: (url: string) => Promise<void>,
): () => void {
  const onClick = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    event.preventDefault();
    openUrl(link.getAttribute("href")!).catch((e: unknown) =>
      logError("open link", e instanceof Error ? e.message : String(e)),
    );
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}
