/**
 * The actor cannot be spoofed. Requests set it and background work may only
 * resume as the canonical Owner. Plugin services inherit that ambient actor;
 * plugins cannot name another user.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditEntries: Array<Record<string, unknown>> = [];
const h = vi.hoisted(() => ({
  reachable: new Set<number>([1]),
  resolvedFor: [] as Array<{ id: number; userId: string }>,
}));

vi.mock("../../../utils/audit-logger.js", () => ({
  logAudit: async (entry: Record<string, unknown>) => {
    auditEntries.push(entry);
  },
}));
vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentPluginPermissionGrantRepository: () => ({
    listByPlugin: async () =>
      ["hosts:read", "ssh:connect", "credentials:use"].map((capability) => ({
        capability,
      })),
  }),
  createCurrentHostResolutionRepository: () => ({
    findHostOwnerId: async () => "owner",
    findHostById: async (id: number) => ({
      id,
      userId: "owner",
      name: "box",
      ip: "10.0.0.1",
      port: 22,
      username: "root",
      tags: null,
      folder: null,
      authType: "password",
    }),
  }),
}));
vi.mock("../../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({
      hasPermission: async () => true,
      canAccessHost: async (_userId: string, hostId: number) => ({
        hasAccess: h.reachable.has(hostId),
        isOwner: false,
        isShared: h.reachable.has(hostId),
      }),
    }),
  },
}));
vi.mock("../../../hosts/host-resolver.js", () => ({
  resolveHostById: async (id: number, userId: string) => {
    h.resolvedFor.push({ id, userId });
    return h.reachable.has(id) ? { id, userId: "owner", ip: "10.0.0.1" } : null;
  },
  resolveHostBySyncId: async () => null,
}));

const { createPluginContext, createPluginHandle } =
  await import("../../../plugins/ctx.js");
const { invalidatePluginPermissionCache } =
  await import("../../../plugins/permissions.js");
const { runAsActor, getActor } = await import("../../../plugins/actor.js");
const { clearServiceRegistry } =
  await import("../../../plugins/service-registry.js");

function contextFor(pluginId: string, extra: Record<string, unknown> = {}) {
  const handle = createPluginHandle(pluginId, { activate: () => {} });
  return createPluginContext(
    {
      id: pluginId,
      name: pluginId,
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      license: "MIT",
      category: "Productivity",
      engine: { termix: ">=2.9.0", api: "1" },
      capabilities: [
        "hosts:read",
        "ssh:connect",
        "credentials:use",
      ],
      requires: [{ service: "sample.echo", versionRange: "^1.0.0" }],
      ...extra,
    } as never,
    handle,
  );
}

beforeEach(() => {
  auditEntries.length = 0;
  h.resolvedFor = [];
  h.reachable = new Set([1]);
  invalidatePluginPermissionCache();
});
afterEach(() => clearServiceRegistry());

describe("plugin services inherit the ambient actor", () => {
  function provider() {
    const ctx = contextFor("provider", {
      provides: [
        { service: "sample.echo", version: "1.0.0", permission: "x.use" },
      ],
    });
    ctx.services.provide("sample.echo", {
      whoAmI: async () => getActor(),
    });
  }

  it("passes the authenticated actor to the provider", async () => {
    provider();
    const caller = contextFor("caller");
    const handle = caller.services.get<{ whoAmI: () => Promise<string> }>(
      "sample.echo",
    );
    await runAsActor("alice", "request", async () => {
      expect(await handle.whoAmI()).toBe("alice");
    });
  });

  it("does not invent an actor for a background call", async () => {
    provider();
    const caller = contextFor("caller");
    const handle = caller.services.get<{ whoAmI: () => Promise<string> }>(
      "sample.echo",
    );
    await expect(handle.whoAmI()).rejects.toThrow(/acting user/i);
  });
});

describe("a user cannot reach a host they have no access to", () => {
  it("ctx.hosts answers nothing for it", async () => {
    const ctx = contextFor("reader");
    await runAsActor("alice", "request", async () => {
      expect(await ctx.hosts.get(99)).toBeNull();
      expect(await ctx.hosts.status.get(99)).toBeNull();
      expect(await ctx.hosts.status.check(99)).toBeNull();
    });
  });

  it("ctx.ssh resolves it as the actor and gets nothing", async () => {
    const ctx = contextFor("reader");
    await runAsActor("alice", "request", async () => {
      expect(await ctx.ssh.resolveHost(99)).toBeNull();
    });
    expect(h.resolvedFor).toEqual([{ id: 99, userId: "alice" }]);
  });

  it("ctx.ssh refuses everything without an actor, whatever the host says", async () => {
    const ctx = contextFor("reader");
    await expect(ctx.ssh.resolveHost(1)).rejects.toThrow(/acting user/);
    await expect(
      ctx.ssh.connect({
        id: 1,
        userId: "owner",
        ip: "10.0.0.1",
        port: 22,
        username: "root",
      }),
    ).rejects.toThrow(/acting user/);
    await expect(
      ctx.ssh.jumpChain([{ hostId: 1 }], {
        forHost: {
          id: 1,
          userId: "owner",
          ip: "10.0.0.1",
          port: 22,
          username: "root",
        },
      }),
    ).rejects.toThrow(/acting user/);
  });
});
