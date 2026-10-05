import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  host: null as Record<string, unknown> | null,
  hasAccess: true,
  credentials: new Map<string, Record<string, unknown>>(),
  folderCredentialId: null as number | null,
  pluginSettings: null as Record<string, unknown> | null,
}));

vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentHostResolutionRepository: () => ({
    findHostById: async (_hostId: number, userId: string) =>
      state.host && state.host.userId === userId ? { ...state.host } : null,
    findCredentialByIdForUser: async (credentialId: number, userId: string) =>
      state.credentials.get(`${credentialId}:${userId}`) ?? null,
    findFolderCredentialId: async () => state.folderCredentialId,
  }),
  createCurrentCredentialRepository: () => ({
    findById: async () => null,
  }),
  createCurrentCredentialAccessRepository: () => ({
    findActiveGrant: async () => null,
  }),
  createCurrentRoleRepository: () => ({
    listUserRoleIds: async () => [],
  }),
}));

vi.mock("../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({
      canAccessHost: async () => ({
        hasAccess: state.hasAccess,
        isOwner: state.hasAccess,
        isShared: false,
      }),
    }),
  },
}));

vi.mock("../../utils/shared-credential-secrets-manager.js", () => ({
  SharedCredentialSecretsManager: {
    getInstance: () => ({
      getSecretForUser: async () => null,
      snapshotForUser: async () => {},
    }),
  },
  snapshotAsCredentialRecord: () => null,
}));

vi.mock("../../database/routes/host-plugin-settings.js", () => ({
  loadHostPluginSettings: async () =>
    new Map(state.pluginSettings ? [[42, state.pluginSettings]] : []),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { resolveHostById } from "../../hosts/host-resolver.js";

function baseHost(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    userId: "owner",
    name: "prod",
    ip: "10.0.0.42",
    port: 22,
    username: "root",
    authType: "password",
    password: "owner-secret",
    key: null,
    keyPassword: null,
    keyType: null,
    credentialId: null,
    sudoPassword: "owner-sudo",
    jumpHosts: null,
    terminalConfig: null,
    sshOptions: null,
    overrideCredentialUsername: false,
    portKnockSequence: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.host = baseHost();
  state.hasAccess = true;
  state.credentials.clear();
  state.folderCredentialId = null;
  state.pluginSettings = null;
});

describe("resolveHostById in the single-owner model", () => {
  it("returns null when access is denied", async () => {
    state.hasAccess = false;
    expect(await resolveHostById(42, "owner")).toBeNull();
  });

  it("returns null when the requested row does not belong to the Owner", async () => {
    expect(await resolveHostById(42, "stranger")).toBeNull();
  });

  it("resolves the Owner's saved credential", async () => {
    state.host = baseHost({
      authType: "credential",
      credentialId: 9,
      username: "",
      password: null,
    });
    state.credentials.set("9:owner", {
      id: 9,
      userId: "owner",
      username: "cred-user",
      password: null,
      privateKey: "PRIVATE-KEY",
      key: null,
      keyPassword: "kp",
      keyType: "ssh-ed25519",
      certPublicKey: null,
    });

    const host = (await resolveHostById(42, "owner")) as Record<string, unknown>;

    expect(host.key).toBe("PRIVATE-KEY");
    expect(host.username).toBe("cred-user");
    expect(host.authType).toBe("key");
    expect(host.sudoPassword).toBe("owner-sudo");
  });

  it("falls back to the folder credential when the host has none", async () => {
    state.host = baseHost({
      authType: "credential",
      credentialId: null,
      folder: "switches",
      username: "",
      password: null,
    });
    state.folderCredentialId = 11;
    state.credentials.set("11:owner", {
      id: 11,
      userId: "owner",
      username: "folder-user",
      password: "folder-pass",
      privateKey: null,
      key: null,
      keyPassword: null,
      keyType: null,
    });

    const host = (await resolveHostById(42, "owner")) as Record<string, unknown>;

    expect(host.password).toBe("folder-pass");
    expect(host.username).toBe("folder-user");
    expect(host.authType).toBe("password");
  });

  it("prefers a host credential over its folder credential", async () => {
    state.host = baseHost({
      authType: "credential",
      credentialId: 9,
      folder: "switches",
      username: "",
      password: null,
    });
    state.folderCredentialId = 11;
    state.credentials.set("9:owner", {
      id: 9,
      userId: "owner",
      username: "host-user",
      password: "host-pass",
      privateKey: null,
      key: null,
      keyPassword: null,
      keyType: null,
    });

    const host = (await resolveHostById(42, "owner")) as Record<string, unknown>;

    expect(host.username).toBe("host-user");
    expect(host.password).toBe("host-pass");
  });

  it("recovers legacy sudo and SSH options from terminal_config", async () => {
    state.host = baseHost({
      sudoPassword: null,
      terminalConfig: JSON.stringify({
        sudoPassword: "legacy-sudo",
        keepaliveInterval: 12,
        theme: "nord",
      }),
    });

    const host = (await resolveHostById(42, "owner")) as Record<string, unknown>;

    expect(host.sudoPassword).toBe("legacy-sudo");
    expect(host.sshOptions).toEqual({ keepaliveInterval: 12 });
    expect(host.terminalConfig).toEqual({
      keepaliveInterval: 12,
      theme: "nord",
    });
  });

  it("prefers the dedicated ssh_options column", async () => {
    state.host = baseHost({
      sshOptions: JSON.stringify({ keepaliveCountMax: 3 }),
      terminalConfig: JSON.stringify({ keepaliveInterval: 12 }),
    });

    const host = (await resolveHostById(42, "owner")) as Record<string, unknown>;

    expect(host.sshOptions).toEqual({ keepaliveCountMax: 3 });
  });

  it("parses port-knock JSON without inventing a knock", async () => {
    state.host = baseHost({ portKnockSequence: "[]" });
    let host = (await resolveHostById(42, "owner")) as Record<string, unknown>;
    expect(host.portKnockSequence).toEqual([]);

    state.host = baseHost({
      portKnockSequence: '[{"port":1234,"protocol":"tcp","delay":100}]',
    });
    host = (await resolveHostById(42, "owner")) as Record<string, unknown>;
    expect(host.portKnockSequence).toEqual([
      { port: 1234, protocol: "tcp", delay: 100 },
    ]);
  });

  it("attaches this host's plugin settings only", async () => {
    state.pluginSettings = { fileManager: { defaultPath: "/srv" } };

    const host = (await resolveHostById(42, "owner")) as Record<string, unknown>;

    expect(host.pluginSettings).toEqual(state.pluginSettings);
  });
});
