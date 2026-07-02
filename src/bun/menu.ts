/**
 * Native application menu. Pure config — the Electrobun setter is injected so
 * the structure stays testable without native bindings. Role-based items get
 * native behavior and standard shortcuts; the Edit roles are what make
 * Cmd+C/V/X/A work inside the webview at all.
 */

export type MenuItem = {
  type?: "normal" | "divider" | "separator";
  label?: string;
  role?: string;
  action?: string;
  accelerator?: string;
  submenu?: MenuItem[];
};

export function applicationMenu(): MenuItem[] {
  return [
    {
      label: "Mast",
      submenu: [
        { role: "about" },
        { type: "divider" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "divider" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "divider" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "toggleFullScreen" }],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "close" },
        { type: "divider" },
        { role: "bringAllToFront" },
      ],
    },
  ];
}

export function installApplicationMenu(setMenu: (menu: MenuItem[]) => void): void {
  setMenu(applicationMenu());
}
