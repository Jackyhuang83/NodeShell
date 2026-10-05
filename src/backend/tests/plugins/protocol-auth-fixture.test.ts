/**
 * A fixture plugin declares a protocol core does not know ("spice") and gets a
 * per-host login stored, encrypted and resolved for the owning user.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@termix/plugin-sdk/manifest";
import { TestSqliteDatabase } from "../database/repositories/test-support.js";
import type { DatabaseContext } from "../../database/repositories/database-context.js";

const state = vi.hoisted(() => ({
  db: null as null | { drizzle: unknown },
  keys: new Map<string, Buffer>(),
}));

vi.mock("../../database/db/index.js", () => ({
  getDb: () => state.db!.drizzle,
  getSqlite: () => null,
}));
vi.mock("../../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: {
    triggerSave: vi.fn(),
    forceSave: vi.fn(async () => {}),
  },
}));
vi.mock("../../utils/audit-logger.js", () => ({
  logAudit: vi.fn(async () => {}),
  getAuditUsername: async (id: string) => id,
  getRequestMeta: () => ({}),
}));
vi.mock("../../utils/data-crypto.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/data-crypto.js")>();
  const DataCrypto = actual.DataCrypto as unknown as Record<string, unknown>;
  DataCrypto.getUserDataKey = (userId: string) =>
    state.keys.get(userId) ?? null;
  DataCrypto.validateUserAccess = (userId: string) => {
    const key = state.keys.get(userId);
    if (!key) throw new Error(`User ${userId} has no data encryption key`);
    return key;
  };
  return actual;
});
vi.mock("../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({
      canAccessHost: async (userId: string) =>
        userId === "owner"
          ? {
              hasAccess: true,
              isOwner: true,
              isShared: false,
              permissionLevel: "manage",
            }
          : { hasAccess: false, isOwner: false, isShared: false },
      hasPermission: async () => true,
    }),
  },
}));

import { setHostProtocolSource } from "../../hosts/protocol-auth/registry.js";
import {
  loadProtocolAuthSummaries,
  readProtocolAuthPayload,
  writeProtocolAuth,
} from "../../hosts/protocol-auth/protocol-auth.js";
import { createPluginContext, createPluginHandle } from "../../plugins/ctx.js";
import { invalidatePluginPermissionCache } from "../../plugins/permissions.js";
import { runAsActor } from "../../plugins/actor.js";
import { FieldCrypto } from "../../utils/field-crypto.js";

const HOST_ID = 10;
const manifest = {
  id: "fixture-spice",
  name: "Fixture Spice",
  version: "1.0.0",
  description: "",
  author: { name: "test" },
  license: "MIT",
  category: "Productivity",
  engine: { termix: ">=2.9.0", api: "1" },
  capabilities: ["credentials:read"],
  contributes: {
    protocols: [
      {
        id: "spice",
        credentialFields: [{ key: "display" }, { key: "ticket", secret: true }],
      },
    ],
  },
} as PluginManifest;

let database: TestSqliteDatabase | null = null;
let context: DatabaseContext;

async function exec(query: string): Promise<void> {
  await context.drizzle.run(sql.raw(query));
}

beforeEach(async () => {
  database = new TestSqliteDatabase("sqlite");
  context = await database.connect();
  state.db = context;
  state.keys = new Map([["owner", crypto.randomBytes(32)]]);
  for (const statement of [
    `INSERT INTO users (id, username, password_hash) VALUES ('owner', 'owner', 'x')`,
    `INSERT INTO ssh_credentials (id, user_id, name, username, password, auth_type)
      VALUES (6, 'owner', 'owners', 'cred-user', 'cred-pass', 'password')`,
    `INSERT INTO ssh_data (id, user_id, name, ip, port, username, password, auth_type)
      VALUES (${HOST_ID}, 'owner', 'desk', '10.0.0.10', 22, 'root', 'ssh-pass', 'password')`,
    `INSERT INTO plugins (id, name, version, state, manifest_json)
      VALUES ('fixture-spice', 'Fixture Spice', '1.0.0', 'enabled', '{}')`,
    `INSERT INTO plugin_permission_grants (plugin_id, capability, source)
      VALUES ('fixture-spice', 'credentials:read', 'bundled')`,
  ]) await exec(statement);
  invalidatePluginPermissionCache();
  setHostProtocolSource(() =>
    manifest.contributes!.protocols!.map((protocol) => ({
      ...protocol,
      pluginId: manifest.id,
      pluginName: manifest.name,
    })),
  );
});

afterEach(async () => {
  setHostProtocolSource(() => []);
  await database?.close();
  database = null;
});

function pluginCtx() {
  return createPluginContext(
    manifest,
    createPluginHandle(manifest.id, { activate: () => {} }),
  );
}

async function storeLogin(): Promise<void> {
  const patch = readProtocolAuthPayload({
    protocolAuth: {
      spice: {
        authType: "direct",
        username: "viewer",
        password: "spice-pass",
        fields: { display: "2", ticket: "t-secret" },
      },
    },
  });
  await writeProtocolAuth("owner", HOST_ID, patch!, { isOwner: true });
}

async function storedRow(): Promise<Record<string, unknown>> {
  const rows = (await context.drizzle.all(
    sql.raw(`SELECT * FROM host_protocol_auth WHERE host_id = ${HOST_ID}`),
  )) as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("owner-only plugin protocol authentication", () => {
  it("stores the login encrypted with the owner's key", async () => {
    await storeLogin();
    const row = await storedRow();
    expect(row.protocol).toBe("spice");
    expect(row.username).toBe("viewer");
    expect(JSON.parse(row.fields as string)).toEqual({ display: "2" });
    expect(String(row.password)).not.toContain("spice-pass");
    expect(
      FieldCrypto.decryptField(
        row.password as string,
        state.keys.get("owner")!,
        "",
        "password",
      ),
    ).toBe("spice-pass");
    const summaries = await loadProtocolAuthSummaries([{ id: HOST_ID }]);
    expect(summaries.get(HOST_ID)?.spice).toMatchObject({
      authType: "direct",
      username: "viewer",
      hasPassword: true,
    });
  });

  it("resolves the owner's login for the declaring plugin", async () => {
    await storeLogin();
    const target = await runAsActor("owner", "request", () =>
      pluginCtx().credentials.resolveHostProtocol(HOST_ID, "spice"),
    );
    expect(target?.shared).toBe(false);
    expect(target?.auth).toEqual({
      authType: "direct",
      username: "viewer",
      password: "spice-pass",
      fields: { display: "2", ticket: "t-secret" },
    });
  });

  it("treats a tampered password as missing", async () => {
    await storeLogin();
    const row = await storedRow();
    const envelope = JSON.parse(row.password as string);
    envelope.tag = "0".repeat(envelope.tag.length);
    await exec(
      `UPDATE host_protocol_auth SET password = '${JSON.stringify(envelope)}' WHERE host_id = ${HOST_ID}`,
    );
    const target = await runAsActor("owner", "request", () =>
      pluginCtx().credentials.resolveHostProtocol(HOST_ID, "spice"),
    );
    expect(target?.auth.password).toBe("");
    expect(target?.auth.fields.ticket).toBe("t-secret");
  });

  it("follows a credential the owner selects", async () => {
    const patch = readProtocolAuthPayload({
      protocolAuth: { spice: { authType: "credential", credentialId: 6 } },
    });
    await writeProtocolAuth("owner", HOST_ID, patch!, { isOwner: true });
    const target = await runAsActor("owner", "request", () =>
      pluginCtx().credentials.resolveHostProtocol(HOST_ID, "spice"),
    );
    expect(target?.auth).toMatchObject({
      authType: "credential",
      username: "cred-user",
      password: "cred-pass",
    });
  });
});
