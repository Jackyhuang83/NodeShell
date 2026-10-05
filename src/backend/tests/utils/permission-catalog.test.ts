import { afterEach, describe, expect, it } from "vitest";
import {
  getPermissionCatalog,
  isValidPermission,
  markPluginPermissionsDisabled,
  registerPluginPermissions,
  resetPermissionCatalog,
} from "../../utils/permission-catalog.js";

const GROUP = "testplugin";
const PERMISSIONS = ["testplugin.view", "testplugin.manage"];

function register() {
  registerPluginPermissions({
    group: GROUP,
    pluginId: GROUP,
    label: "Test Plugin",
    icon: "Sparkles",
    permissions: PERMISSIONS,
    items: PERMISSIONS.map((permission) => ({
      permission,
      titleKey: "permissions.x.title",
      descriptionKey: "permissions.x.description",
    })),
  });
}

describe("plugin permission namespace catalog", () => {
  afterEach(() => resetPermissionCatalog());

  it("has no built-in user RBAC permissions", () => {
    expect(getPermissionCatalog()).toEqual([]);
    expect(isValidPermission("hosts.share")).toBe(false);
    expect(isValidPermission("admin.users.manage")).toBe(false);
  });

  it("accepts a plugin's permissions only after registration", () => {
    expect(isValidPermission("testplugin.view")).toBe(false);
    register();
    expect(isValidPermission("testplugin.view")).toBe(true);
    expect(isValidPermission("testplugin.manage")).toBe(true);
    expect(isValidPermission("testplugin.*")).toBe(true);
  });

  it("keeps a disabled loaded plugin namespace reserved", () => {
    register();
    markPluginPermissionsDisabled(GROUP);

    expect(isValidPermission("testplugin.view")).toBe(true);
    expect(isValidPermission("testplugin.*")).toBe(true);
    expect(getPermissionCatalog()[0]?.enabled).toBe(false);
  });

  it("carries plugin metadata and re-registration does not duplicate a group", () => {
    register();
    register();

    const entries = getPermissionCatalog().filter(
      (entry) => entry.group === GROUP,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pluginId: GROUP,
      label: "Test Plugin",
      icon: "Sparkles",
      enabled: true,
    });
  });

  it("still accepts the Owner wildcard used by PermissionManager", () => {
    expect(isValidPermission("*")).toBe(true);
  });
});
