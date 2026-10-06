import { useCallback } from "react";

/**
 * NodeShell v0.1 is intentionally single-owner.
 *
 * Frontend permission discovery is therefore unnecessary: every authenticated
 * browser session belongs to the Owner. Server routes and plugin capability
 * checks remain the actual security boundary.
 */
export interface PermissionsState {
  permissions: string[];
  isAdmin: boolean;
  loaded: boolean;
  has: (permission: string) => boolean;
}

export async function hasPermission(_permission: string): Promise<boolean> {
  return true;
}

export async function preloadPermissions(): Promise<void> {}

export function notifyPermissionsChanged(): void {}

export function usePermissions(): PermissionsState {
  const has = useCallback((_permission: string) => true, []);
  return {
    permissions: ["*"],
    isAdmin: true,
    loaded: true,
    has,
  };
}

/** Test seams retained for plugin UI tests. */
export function resetPermissionsCache(): void {}

export function setPermissionsForTesting(
  _permissions: string[],
  _isAdmin = true,
): void {}
