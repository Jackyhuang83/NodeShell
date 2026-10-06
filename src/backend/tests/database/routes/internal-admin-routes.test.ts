import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: "internal-test-token-0123456789abcdef",
  users: [] as Array<{
    id: string;
    username: string;
    isAdmin: boolean;
    isOidc: boolean;
  }>,
}));

vi.mock("../../../utils/system-crypto.js", () => ({
  SystemCrypto: {
    getInstance: () => ({
      getInternalAuthToken: async () => state.token,
    }),
  },
}));

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      registerUser: vi.fn(async () => {}),
      recoverUserDataKey: vi.fn(async () => true),
    }),
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  authLogger: {
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentUserRepository: () => ({
    listAll: async () => state.users,
    countAll: async () => state.users.length,
    findOwner: async () =>
      state.users.find((user) => user.isAdmin) ?? null,
    createFirstLocalUser: async () => {
      throw new Error("not used by these tests");
    },
    delete: async () => true,
  }),
  createCurrentRoleRepository: () => ({
    assignRoleNameToUser: async () => true,
  }),
}));

vi.mock(
  "../../../database/routes/user-password-reset-routes.js",
  () => ({
    resetUserPassword: vi.fn(async () => ({
      status: "reset",
      dataWiped: false,
    })),
  }),
);

import internalAdminRoutes from "../../../database/routes/internal-admin-routes.js";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/internal/admin", internalAdminRoutes);
  return instance;
}

function auth(req: request.Test) {
  return req.set("Authorization", `Bearer ${state.token}`);
}

beforeEach(() => {
  state.users = [];
});

describe("internal admin boundary", () => {
  it("rejects a request that traversed the reverse proxy even with the token", async () => {
    const response = await auth(
      request(app()).get("/internal/admin/status"),
    ).set("X-Real-IP", "203.0.113.10");

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/local/i);
  });

  it("rejects a loopback request with the wrong internal token", async () => {
    const response = await request(app())
      .get("/internal/admin/status")
      .set("Authorization", "Bearer wrong-token");

    expect(response.status).toBe(401);
  });

  it("reports an uninitialized installation over the local authenticated channel", async () => {
    const response = await auth(request(app()).get("/internal/admin/status"));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      initialized: false,
      userCount: 0,
      owner: null,
    });
  });

  it("permanently closes create-owner after any account exists", async () => {
    state.users = [
      {
        id: "owner-1",
        username: "admin",
        isAdmin: true,
        isOidc: false,
      },
    ];

    const response = await auth(
      request(app()).post("/internal/admin/create-owner"),
    ).send({
      username: "second-owner",
      password: "correct-horse-battery-staple",
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/already initialized/i);
  });

  it("does not use the recovery channel for a non-owner account", async () => {
    state.users = [
      {
        id: "user-1",
        username: "member",
        isAdmin: false,
        isOidc: false,
      },
    ];

    const response = await auth(
      request(app()).post("/internal/admin/reset-password"),
    ).send({
      username: "member",
      newPassword: "correct-horse-battery-staple",
    });

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/owner/i);
  });
});
