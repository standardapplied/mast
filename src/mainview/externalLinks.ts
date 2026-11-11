import { logError } from "./errorLog";

const MIDDLE_BUTTON = 1;

/**
 * Every link in the app leaves it: a click or a middle click on any anchor opens its address
 * through `openUrl` (the core's `open_url`, which admits http, https and mailto) and never
 * navigates the webview, whose page holds every live session. One window listener, in the capture
 * phase so no handler on the way can stop it first; the core's navigation guard stands behind it
 * for whatever reaches the webview another way.
 */
export function openLinksOutside(target: Window, openUrl: (url: string) => Promise<void>): void {
  const follow = (event: MouseEvent) => {
    if (event.type === "auxclick" && event.button !== MIDDLE_BUTTON) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    event.preventDefault();
    openUrl(link.getAttribute("href")!).catch((e: unknown) =>
      logError("open link", e instanceof Error ? e.message : String(e)),
    );
  };
  target.addEventListener("click", follow, true);
  target.addEventListener("auxclick", follow, true);
}
