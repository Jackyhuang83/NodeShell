import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  databaseLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const state = vi.hoisted(() => ({
  ownerIds: new Set<string>(),
  ownedByUser: new Map<string, Set<number>>(),
  ownedQueryCalls: 0,
  failOwnedLookup: false,
  failListLookup: false,
}));

vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentHostResolutionRepository: () => ({
    isHostOwnedByUser: async (hostId: number, userId: string) => {
      if (state.failOwnedLookup) throw new Error("ownership lookup failed");
      return state.ownedByUser.get(userId)?.has(hostId) ?? false;
    },
    listOwnedHostIds: async (userId: string) => {
      state.ownedQueryCalls += 1;
      if (state.failListLookup) throw new Error("owned-host list failed");
      return state.ownedByUser.get(userId) ?? new Set<number>();
    },
  }),
  createCurrentUserRepository: () => ({
    findById: async (userId: string) =>
      state.ownerIds.has(userId) ? { id: userId, isAdmin: true } : null,
  }),
}));

const { PermissionManager } = await import("../../utils/permission-manager.js");

describe("PermissionManager single-owner model", () => {
  const manager = PermissionManager.getInstance();

  beforeEach(() => {
    vi.restoreAllMocks();
    state.ownerIds = new Set(["owner"]);
    state.ownedByUser = new Map([["owner", new Set([1, 2, 42])]]);
    state.ownedQueryCalls = 0;
    state.failOwnedLookup = false;
    state.failListLookup = false;
  });

  it("gives the Owner the global permission surface and nobody else", async () => {
    expect(await manager.getUserPermissions("owner")).toEqual(["*"]);
    expect(await manager.hasPermission("owner", "hosts.read")).toBe(true);
    expect(await manager.hasPermission("owner", "anything.at.all")).toBe(true);

    expect(await manager.getUserPermissions("stranger")).toEqual([]);
    expect(await manager.hasPermission("stranger", "hosts.read")).toBe(false);
  });

  it("grants every host action only when the authenticated Owner owns the row", async () => {
    for (const action of ["connect", "view", "edit", "manage", "delete"] as const) {
      expect(await manager.canAccessHost("owner", 42, action)).toEqual({
        hasAccess: true,
        isOwner: true,
        isShared: false,
      });
    }

    expect(await manager.canAccessHost("owner", 99, "connect")).toEqual({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
  });

  it("does not provide an admin bypass for another account", async () => {
    state.ownerIds.add("other-admin");
    state.ownedByUser.set("other-admin", new Set());

    expect(await manager.canAccessHost("other-admin", 42, "manage")).toEqual({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
  });

  it("denies a non-Owner before host ownership can grant anything", async () => {
    state.ownedByUser.set("stranger", new Set([42]));

    expect(await manager.canAccessHost("stranger", 42, "connect")).toEqual({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
  });

  it("filters a fleet to the Owner's own host ids with one batched lookup", async () => {
    const allowed = await manager.filterAccessibleHostIds("owner", [1, 2, 3, 42, 99]);

    expect([...allowed].sort((a, b) => a - b)).toEqual([1, 2, 42]);
    expect(state.ownedQueryCalls).toBe(1);
  });

  it("returns no hosts for a non-Owner and does not query ownership", async () => {
    const allowed = await manager.filterAccessibleHostIds("stranger", [1, 2, 42]);

    expect([...allowed]).toEqual([]);
    expect(state.ownedQueryCalls).toBe(0);
  });

  it("short-circuits an empty fleet", async () => {
    const allowed = await manager.filterAccessibleHostIds("owner", []);

    expect(allowed.size).toBe(0);
    expect(state.ownedQueryCalls).toBe(0);
  });

  it("fails closed when ownership checks fail", async () => {
    state.failOwnedLookup = true;
    expect(await manager.canAccessHost("owner", 42, "connect")).toEqual({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });

    state.failListLookup = true;
    expect((await manager.filterAccessibleHostIds("owner", [1, 2])).size).toBe(0);
  });
});
