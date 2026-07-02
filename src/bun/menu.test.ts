import { describe, expect, test } from "bun:test";
import { applicationMenu, installApplicationMenu, type MenuItem } from "./menu";

function roles(items: MenuItem[]): string[] {
  return items.flatMap((i) => [...(i.role ? [i.role] : []), ...roles(i.submenu ?? [])]);
}

describe("application menu", () => {
  test("carries the app, edit, view, and window menus", () => {
    const menu = applicationMenu();
    expect(menu.map((m) => m.label)).toEqual(["Mast", "Edit", "View", "Window"]);
  });

  test("edit roles make native clipboard shortcuts work", () => {
    const all = roles(applicationMenu());
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      expect(all).toContain(role);
    }
    expect(all).toContain("quit");
    expect(all).toContain("minimize");
  });

  test("installApplicationMenu hands the structure to the injected setter", () => {
    let received: MenuItem[] | null = null;
    installApplicationMenu((menu) => {
      received = menu;
    });
    expect(received).toEqual(applicationMenu());
  });
});
