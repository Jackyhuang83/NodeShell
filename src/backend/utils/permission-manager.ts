import type { Request, Response, NextFunction } from "express";
import {
  createCurrentHostResolutionRepository,
  createCurrentUserRepository,
} from "../database/repositories/factory.js";
import { databaseLogger } from "./logger.js";

interface AuthenticatedRequest extends Request {
  userId?: string;
  dataKey?: Buffer;
}

// Kept temporarily as a type compatibility surface while the remaining
// multi-user records are removed. NodeShell v0.1 never grants shared access.
const SHARE_PERMISSION_LEVELS = ["connect", "view", "edit", "manage"] as const;
type SharePermissionLevel = (typeof SHARE_PERMISSION_LEVELS)[number];
export type HostAction = SharePermissionLevel | "delete";

interface HostAccessInfo {
  hasAccess: boolean;
  isOwner: boolean;
  isShared: boolean;
  isAdminBypass?: boolean;
  permissionLevel?: SharePermissionLevel;
  expiresAt?: string | null;
}

interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * NodeShell v0.1 is deliberately single-owner.
 *
 * Permission gates therefore have one security rule: the authenticated account
 * must be the Owner. Host access additionally requires that the host row belongs
 * to that same Owner. Legacy RBAC/share tables are not consulted.
 */
class PermissionManager {
  private static instance: PermissionManager;

  private constructor() {}

  static getInstance(): PermissionManager {
    if (!this.instance) this.instance = new PermissionManager();
    return this.instance;
  }

  invalidateUserPermissionCache(_userId: string): void {
    // No role/permission cache exists in the single-owner model.
  }

  async getUserPermissions(userId: string): Promise<string[]> {
    return (await this.isAdmin(userId)) ? ["*"] : [];
  }

  async hasPermission(userId: string, _permission: string): Promise<boolean> {
    return this.isAdmin(userId);
  }

  async canAccessHost(
    userId: string,
    hostId: number,
    _action: HostAction = "connect",
  ): Promise<HostAccessInfo> {
    try {
      if (!(await this.isAdmin(userId))) {
        return { hasAccess: false, isOwner: false, isShared: false };
      }

      const owned =
        await createCurrentHostResolutionRepository().isHostOwnedByUser(
          hostId,
          userId,
        );

      return {
        hasAccess: owned,
        isOwner: owned,
        isShared: false,
      };
    } catch (error) {
      databaseLogger.error("Failed to check host ownership", error, {
        operation: "can_access_host",
        userId,
        hostId,
      });
      return { hasAccess: false, isOwner: false, isShared: false };
    }
  }

  async filterAccessibleHostIds(
    userId: string,
    hostIds: number[],
  ): Promise<Set<number>> {
    if (hostIds.length === 0 || !(await this.isAdmin(userId))) {
      return new Set();
    }

    try {
      const owned =
        await createCurrentHostResolutionRepository().listOwnedHostIds(userId);
      return new Set(hostIds.filter((id) => owned.has(id)));
    } catch (error) {
      databaseLogger.error("Failed to filter owned hosts", error, {
        operation: "filter_accessible_hosts",
        userId,
      });
      return new Set();
    }
  }

  async isAdmin(userId: string): Promise<boolean> {
    try {
      const user = await createCurrentUserRepository().findById(userId);
      return user?.isAdmin === true;
    } catch (error) {
      databaseLogger.error("Failed to check owner status", error, {
        operation: "is_admin",
        userId,
      });
      return false;
    }
  }

  requirePermission(permission: string) {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction,
    ) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (!(await this.hasPermission(userId, permission))) {
        databaseLogger.warn("Owner permission denied", {
          operation: "permission_check",
          userId,
          permission,
          path: req.path,
        });
        return res.status(403).json({
          error: "Insufficient permissions",
          required: permission,
        });
      }

      next();
    };
  }

  requireHostAccess(
    hostIdParam: string = "id",
    action: HostAction = "connect",
  ) {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction,
    ) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const hostIdValue = Array.isArray(req.params[hostIdParam])
        ? req.params[hostIdParam][0]
        : req.params[hostIdParam];
      const hostId = parseInt(hostIdValue, 10);
      if (isNaN(hostId)) {
        return res.status(400).json({ error: "Invalid host ID" });
      }

      const accessInfo = await this.canAccessHost(userId, hostId, action);
      if (!accessInfo.hasAccess) {
        databaseLogger.warn("Host ownership check denied", {
          operation: "host_access_check",
          userId,
          hostId,
          action,
        });
        return res.status(403).json({
          error: "Access denied to host",
          hostId,
          action,
        });
      }

      (req as unknown as { hostAccessInfo: HostAccessInfo }).hostAccessInfo =
        accessInfo;
      next();
    };
  }

  requireAdmin() {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction,
    ) => {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (!(await this.isAdmin(userId))) {
        databaseLogger.warn("Owner access denied", {
          operation: "admin_check",
          userId,
          path: req.path,
        });
        return res.status(403).json({ error: "Admin access required" });
      }

      next();
    };
  }
}

export { PermissionManager, SHARE_PERMISSION_LEVELS };
export type {
  AuthenticatedRequest,
  HostAccessInfo,
  PermissionCheckResult,
  SharePermissionLevel,
};
