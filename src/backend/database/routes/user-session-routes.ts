import type { AuthenticatedRequest } from "../../../types/index.js";
import type { RequestHandler, Router } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { authLogger } from "../../utils/logger.js";
import { logAudit, getRequestMeta } from "../../utils/audit-logger.js";
import {
  createCurrentSessionRepository,
  createCurrentUserRepository,
} from "../repositories/factory.js";

type UserSessionRoutesDeps = {
  authenticateJWT: RequestHandler;
  authManager: AuthManager;
};

/**
 * Owner-only session management.
 *
 * NodeShell v0.1 has exactly one Owner account. Session APIs therefore never
 * enumerate, target, or revoke another user's sessions.
 */
export function registerUserSessionRoutes(
  router: Router,
  { authenticateJWT, authManager }: UserSessionRoutesDeps,
): void {
  router.get("/sessions", authenticateJWT, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId;
    const currentSessionId = authReq.sessionId;

    try {
      const userRecord =
        await createCurrentUserRepository().findById(userId);
      if (!userRecord) {
        return res.status(404).json({ error: "User not found" });
      }

      const sessions = await authManager.getUserSessions(userId);
      return res.json({
        sessions: sessions.map((session) => ({
          id: session.id,
          userId: session.userId,
          deviceType: session.deviceType,
          deviceInfo: session.deviceInfo,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          lastActiveAt: session.lastActiveAt,
          isRevoked: session.isRevoked,
          isCurrentSession: session.id === currentSessionId,
        })),
      });
    } catch (err) {
      authLogger.error("Failed to get sessions", err);
      return res.status(500).json({ error: "Failed to get sessions" });
    }
  });

  router.delete("/sessions/:sessionId", authenticateJWT, async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    const sessionId = Array.isArray(req.params.sessionId)
      ? req.params.sessionId[0]
      : req.params.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }

    try {
      const userRecord =
        await createCurrentUserRepository().findById(userId);
      if (!userRecord) {
        return res.status(404).json({ error: "User not found" });
      }

      const session =
        await createCurrentSessionRepository().findById(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (session.userId !== userId) {
        return res.status(403).json({
          error: "Not authorized to revoke this session",
        });
      }

      const success = await authManager.revokeSession(sessionId);
      if (!success) {
        return res.status(500).json({ error: "Failed to revoke session" });
      }

      authLogger.success("Session revoked", {
        operation: "session_revoke",
        sessionId,
        userId,
      });

      const { ipAddress, userAgent } = getRequestMeta(req);
      await logAudit({
        userId,
        username: userRecord.username ?? userId,
        action: "revoke_session",
        resourceType: "session",
        resourceId: sessionId,
        ipAddress,
        userAgent,
        success: true,
      });

      return res.json({
        success: true,
        message: "Session revoked successfully",
      });
    } catch (err) {
      authLogger.error("Failed to revoke session", err);
      return res.status(500).json({ error: "Failed to revoke session" });
    }
  });

  router.post("/sessions/revoke-all", authenticateJWT, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId;
    const { exceptCurrent } = req.body ?? {};

    try {
      const userRecord =
        await createCurrentUserRepository().findById(userId);
      if (!userRecord) {
        return res.status(404).json({ error: "User not found" });
      }

      const currentSessionId = exceptCurrent ? authReq.sessionId : undefined;
      const revokedCount = await authManager.revokeAllUserSessions(
        userId,
        currentSessionId,
      );

      authLogger.success("Owner sessions revoked", {
        operation: "user_sessions_revoke_all",
        userId,
        exceptCurrent: !!exceptCurrent,
        revokedCount,
      });

      const { ipAddress, userAgent } = getRequestMeta(req);
      await logAudit({
        userId,
        username: userRecord.username ?? userId,
        action: "revoke_all_sessions",
        resourceType: "session",
        resourceId: userId,
        resourceName: userRecord.username,
        details: JSON.stringify({
          revokedCount,
          exceptCurrent: !!exceptCurrent,
        }),
        ipAddress,
        userAgent,
        success: true,
      });

      return res.json({
        message: `${revokedCount} session(s) revoked successfully`,
        count: revokedCount,
      });
    } catch (err) {
      authLogger.error("Failed to revoke user sessions", err);
      return res.status(500).json({ error: "Failed to revoke sessions" });
    }
  });
}
