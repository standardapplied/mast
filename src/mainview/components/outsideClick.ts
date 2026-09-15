import type { RefObject } from "react";

/**
 * Whether a mousedown landed inside `ref` for the purpose of closing on outside click. A Select's
 * option list portals to document.body (DropdownPanel), so a click on an option is outside every
 * ancestor's DOM subtree; closing on it would swallow the click before it selects. Every
 * outside-closer — Dialog, menus, the Select itself — treats a floating panel as inside.
 */
export function clickedInside(ref: RefObject<HTMLElement | null>, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  if (ref.current?.contains(target)) return true;
  return target instanceof Element && target.closest(".dropdown-panel") !== null;
}
