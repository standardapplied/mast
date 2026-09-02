/**
 * The catalog store's connection lanes, stubbed empty-but-well-formed, for
 * component tests whose fake gateway is scoped to the surface under test.
 * Surfaces that adopt the gateway into the catalog store (dialogs, log
 * panels) wire these lanes on mount; the fakes spread this in so the store
 * seeds an empty world instead of exploding on a missing method. Spread it
 * BEFORE the fake's own members so the surface-scoped ones win.
 */
export function catalogLaneStubs() {
  return {
    listRooms: async () => ({ ok: true as const, value: { rooms: [], count: 0 } }),
    getRoom: async (id: string) => ({
      ok: false as const,
      error: { status: 404, code: "room_not_found", message: `no '${id}' in this fake` },
    }),
    getSpec: async (id: string) => ({
      ok: false as const,
      error: { status: 404, code: "spec_not_found", message: `no '${id}' in this fake` },
    }),
    listRuns: async () => ({ ok: true as const, value: { runs: [] } }),
    listSpecs: async () => ({ ok: true as const, value: { specs: [], total: 0 } }),
    listProjects: async () => ({ ok: true as const, value: { projects: [] } }),
    recentEvents: async () => ({
      ok: true as const,
      value: { limit: 0, returned: 0, events: [] },
    }),
    whoami: async () => ({
      ok: false as const,
      error: { status: 404, code: "not_found", message: "no whoami in this fake" },
    }),
    onEvent: () => () => {},
    onConnectionStatus: () => () => {},
  };
}
