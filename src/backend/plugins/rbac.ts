/**
 * Resolves plugin-declared permission names into plugin-owned namespaces.
 *
 * NodeShell v0.1 has no user-role RBAC. The Owner is authorized by core.
 * Plugin permission names remain useful only as an SDK contract: a plugin may
 * gate its own route on a permission it declared, and may refer to another
 * loaded plugin's fully-qualified permission without taking over that
 * namespace.
 */

import { getPermissionCatalog } from "../utils/permission-catalog.js";
import type { PluginManifest } from "./manifest.js";

/** The ids this plugin declares, in their registered `<pluginId>.<name>` form. */
export function declaredPermissions(manifest: PluginManifest): Set<string> {
  return new Set(
    (manifest.contributes?.permissions ?? []).map(
      (permission) => `${manifest.id}.${permission.name}`,
    ),
  );
}

export function resolvePermission(
  manifest: PluginManifest,
  permission: string,
): string {
  const head = permission.split(".")[0];
  if (!head) return permission;

  if (head === manifest.id) return permission;

  // A declared relative name always belongs to this plugin, even if its first
  // segment happens to match another loaded plugin id.
  if (
    (manifest.contributes?.permissions ?? []).some(
      (declared) => declared.name === permission,
    )
  ) {
    return `${manifest.id}.${permission}`;
  }

  const otherPlugin = getPermissionCatalog().some(
    (entry) => entry.pluginId !== undefined && entry.group === head,
  );
  if (otherPlugin) return permission;

  return `${manifest.id}.${permission}`;
}
