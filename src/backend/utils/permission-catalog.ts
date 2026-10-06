/**
 * Runtime registry for plugin-defined permission names.
 *
 * NodeShell v0.1 has no user roles or RBAC persistence. The Owner is the only
 * account and PermissionManager authorizes that Owner directly. This catalog
 * exists only so plugins cannot steal each other's permission namespaces and
 * so a loaded plugin can validate the names it declared.
 */
export interface PermissionCatalogItem {
  permission: string;
  titleKey: string;
  descriptionKey: string;
}

export interface PermissionCatalogEntry {
  group: string;
  permissions: string[];
  pluginId?: string;
  label?: string;
  icon?: string;
  enabled?: boolean;
  items?: PermissionCatalogItem[];
}

const pluginPermissionGroups = new Map<string, PermissionCatalogEntry>();

export function registerPluginPermissions(entry: PermissionCatalogEntry): void {
  pluginPermissionGroups.set(entry.group, { ...entry, enabled: true });
}

export function markPluginPermissionsDisabled(pluginId: string): void {
  for (const [group, entry] of pluginPermissionGroups) {
    if (entry.pluginId !== pluginId) continue;
    pluginPermissionGroups.set(group, { ...entry, enabled: false });
  }
}

export function getPermissionCatalog(): PermissionCatalogEntry[] {
  return [...pluginPermissionGroups.values()];
}

export function isValidPermission(permission: string): boolean {
  if (permission === "*") return true;
  for (const entry of pluginPermissionGroups.values()) {
    if (permission === `${entry.group}.*`) return true;
    if (entry.permissions.includes(permission)) return true;
  }
  return false;
}

/** Test seam. */
export function resetPermissionCatalog(): void {
  pluginPermissionGroups.clear();
}
