import Electrobun, { BrowserWindow, Utils } from "electrobun/bun";
import type { AppPushMessages } from "../shared/types";
import type { HandlerDeps } from "./handlers";
import { isExternalHttpUrl, newWindowUrl } from "./navigation";
import { createMainRPC, type MainRPC } from "./rpc";
import { WindowRegistry } from "./window-registry";

const MAINVIEW_URL = "views://mainview/index.html";

type WindowEntry = { window: BrowserWindow<MainRPC>; rpc: MainRPC };

/**
 * Owns the set of open windows: focus order, push broadcast, the quit gate, and
 * the popup policy. Closing the last window exits the app natively
 * (`exitOnLastWindowClosed: true`); `requestQuit` remains the gated path for
 * programmatic quits and will guard unsaved work once authoring introduces it.
 */
export class WindowManager {
  private readonly registry = new WindowRegistry<WindowEntry>();
  private navigationGuardInstalled = false;

  constructor(private readonly deps: Omit<HandlerDeps, "quit">) {}

  open(): WindowEntry {
    this.installNavigationGuard();

    const rpc = createMainRPC({
      ...this.deps,
      quit: () => void this.requestQuit(),
    });

    const window = new BrowserWindow<MainRPC>({
      title: "Mast",
      url: MAINVIEW_URL,
      frame: { x: 160, y: 120, width: 1280, height: 820 },
      titleBarStyle: "hiddenInset",
      rpc,
    });

    const entry: WindowEntry = { window, rpc };
    this.registry.add(entry);
    window.on("close", () => this.registry.remove(entry));

    return entry;
  }

  /** Push a typed message to every open window's webview. */
  broadcast<K extends keyof AppPushMessages & string>(name: K, payload: AppPushMessages[K]): void {
    this.registry.broadcast(({ rpc }) => {
      const send = rpc.send[name] as (payload: AppPushMessages[K]) => void;
      send(payload);
    });
  }

  get focused(): WindowEntry | undefined {
    return this.registry.focused;
  }

  get size(): number {
    return this.registry.size;
  }

  /** Ask every webview's quit gate; only quit if all allow it. */
  async requestQuit(): Promise<boolean> {
    for (const { rpc } of this.registry.all) {
      const { allow } = await rpc.request.confirmQuit();
      if (!allow) return false;
    }
    this.deps.onBeforeQuit?.();
    Utils.quit();
    return true;
  }

  private installNavigationGuard(): void {
    if (this.navigationGuardInstalled) return;
    this.navigationGuardInstalled = true;

    // Popups (target=_blank, cmd-click) only ever escape to the user's real
    // browser when http(s); every other scheme is silently blocked.
    Electrobun.events.on("new-window-open", (event) => {
      const detail = (event as { data?: { detail?: unknown } }).data?.detail;
      const url = newWindowUrl(detail);
      if (url && isExternalHttpUrl(url)) Utils.openExternal(url);
    });
  }
}
