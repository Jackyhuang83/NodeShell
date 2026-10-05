import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  own: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentHostResolutionRepository: () => ({
    findCredentialByIdForUser: async (id: number, userId: string) =>
      state.own.get(`${userId}:${id}`) ?? null,
  }),
}));

const { findUsableCredential } =
  await import("../../hosts/usable-credential.js");

describe("findUsableCredential", () => {
  beforeEach(() => state.own.clear());

  it("returns a credential owned by the authenticated user", async () => {
    state.own.set("alice:1", { id: 1, userId: "alice", password: "mine" });
    expect(await findUsableCredential(1, "alice")).toMatchObject({
      id: 1,
      userId: "alice",
      password: "mine",
    });
  });

  it("never returns another user's credential", async () => {
    state.own.set("owner:2", { id: 2, userId: "owner", password: "secret" });
    expect(await findUsableCredential(2, "bob")).toBeNull();
    expect(await findUsableCredential(99, "bob")).toBeNull();
  });
});
