import type { AuthenticatedRequest } from "../../../types/index.js";
import express, { type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { authLogger } from "../../utils/logger.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { shouldShowDonationModal } from "./donation-modal-utils.js";
import { registerBrandingRoutes } from "./branding-routes.js";
import { registerUserSettingsRoutes } from "./user-settings-routes.js";
import { registerTlsRoutes } from "./tls-routes.js";
import { registerUserSessionRoutes } from "./user-session-routes.js";
import { registerUserDataAccessRoutes } from "./user-data-access-routes.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerAuthCompatRoutes } from "./auth-compat-routes.js";
import { logAudit, getRequestMeta } from "../../utils/audit-logger.js";
import { createCurrentUserRepository } from "../repositories/factory.js";
import type { UserRecord } from "../repositories/user-repository.js";
import { verifyPasswordLogin } from "../../auth/builtin-login-methods.js";
import { respondWithLogin, sendLoginError } from "../../auth/login-pipeline.js";

const authManager = AuthManager.getInstance();
const router = express.Router();

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

async function findCurrentUser(userId: string): Promise<UserRecord | null> {
  return createCurrentUserRepository().findById(userId);
}

const authenticateJWT = authManager.createAuthMiddleware();
const requireAdmin = authManager.createAdminMiddleware();

/**
 * Browser registration is intentionally unavailable in NodeShell v0.1.
 * Keeping this explicit denial gives older clients a safe, deterministic
 * answer without exposing an account-creation path.
 */
router.post("/create", async (_req, res) => {
  return res.status(403).json({
    error:
      "Browser registration is disabled. Create the NodeShell owner with the local admin CLI.",
  });
});

router.post("/login", async (req, res) => {
  authLogger.info("Owner login request received", {
    operation: "user_login_request",
    username: req.body?.username,
  });
  try {
    const identity = await verifyPasswordLogin(req);
    await respondWithLogin(req, res, identity, {
      methodId: "password",
      rememberMe: !!req.body?.rememberMe,
    });
  } catch (error) {
    sendLoginError(res, error);
  }
});

router.post("/logout", authenticateJWT, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.userId) {
      await authManager.logoutUser(authReq.userId, authReq.sessionId);
      authLogger.info("Owner logged out", {
        operation: "user_logout",
        userId: authReq.userId,
        sessionId: authReq.sessionId,
      });
    }

    return res
      .clearCookie("jwt", authManager.getClearCookieOptions(req))
      .json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    authLogger.error("Logout failed", err);
    return res.status(500).json({ error: "Logout failed" });
  }
});

router.get("/me", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  if (!isNonEmptyString(userId)) {
    return res.status(401).json({ error: "Invalid userId" });
  }

  try {
    const user = await findCurrentUser(userId);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    return res.json({
      userId: user.id,
      username: user.username,
      is_admin: !!user.isAdmin,
      // Compatibility fields are deliberately fixed off in the owner-only
      // v0.1 runtime. External identities and browser 2FA are not supported.
      is_external: false,
      is_oidc: false,
      is_dual_auth: false,
      totp_enabled: false,
      show_donation_modal: shouldShowDonationModal(
        user.registeredAt,
        !!user.donationModalDismissed,
      ),
    });
  } catch (err) {
    authLogger.error("Failed to load owner profile", err);
    return res.status(500).json({ error: "Failed to get username" });
  }
});

router.post(
  "/me/dismiss-donation-modal",
  authenticateJWT,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!isNonEmptyString(userId)) {
      return res.status(401).json({ error: "Invalid userId" });
    }

    try {
      const updated = await createCurrentUserRepository().update(userId, {
        donationModalDismissed: true,
      });
      if (!updated) {
        return res.status(401).json({ error: "User not found" });
      }
      return res.json({ success: true });
    } catch (err) {
      authLogger.error("Failed to dismiss donation modal", err);
      return res
        .status(500)
        .json({ error: "Failed to dismiss donation modal" });
    }
  },
);

router.get("/setup-required", async (_req, res) => {
  try {
    const count = await createCurrentUserRepository().countAll();
    return res.json({ setup_required: count === 0 });
  } catch (err) {
    authLogger.error("Failed to check setup status", err);
    return res.status(500).json({ error: "Failed to check setup status" });
  }
});

router.get("/db-health", requireAdmin, async (_req, res) => {
  try {
    await createCurrentUserRepository().countAll();
    return res.json({ status: "ok" });
  } catch (err) {
    authLogger.error("DB health check failed", err);
    return res.status(500).json({ error: "Database not accessible" });
  }
});

router.get("/registration-allowed", async (_req, res) => {
  return res.json({ allowed: false });
});

router.patch("/registration-allowed", authenticateJWT, async (_req, res) => {
  return res.status(403).json({
    error: "Public registration is permanently disabled in NodeShell v0.1",
  });
});

/**
 * Password login is the only browser login mode in the v0.1 owner-only
 * runtime. The compatibility endpoint remains read-only for older UI code.
 */
router.get("/password-login-allowed", async (_req, res) => {
  return res.json({ allowed: true, forced: true });
});

router.patch("/password-login-allowed", authenticateJWT, async (_req, res) => {
  return res.status(403).json({
    error: "Password login cannot be disabled in NodeShell v0.1",
  });
});

router.get("/password-reset-allowed", async (_req, res) => {
  return res.json({ allowed: false });
});

router.patch("/password-reset-allowed", authenticateJWT, async (_req, res) => {
  return res.status(403).json({
    error:
      "Browser-based password recovery is disabled in NodeShell v0.1. Use the local recovery CLI.",
  });
});

router.post("/change-password", authenticateJWT, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { oldPassword, newPassword } = req.body ?? {};

  if (!userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }
  if (!isNonEmptyString(oldPassword) || !isNonEmptyString(newPassword)) {
    return res
      .status(400)
      .json({ error: "Old and new passwords are required." });
  }

  try {
    const user = await findCurrentUser(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isMatch) {
      authLogger.warn("Password change failed - old password incorrect", {
        operation: "password_change_failed",
        userId,
      });
      return res.status(401).json({ error: "Incorrect current password" });
    }

    const success = await authManager.changeUserPassword(
      userId,
      oldPassword,
      newPassword,
    );
    if (!success) {
      return res
        .status(500)
        .json({ error: "Failed to update password and re-encrypt data." });
    }

    await createCurrentUserRepository().update(userId, {
      passwordHash: await bcrypt.hash(newPassword, 10),
    });
    await authManager.logoutUser(userId);

    const { ipAddress, userAgent } = getRequestMeta(req);
    await logAudit({
      userId,
      username: user.username ?? userId,
      action: "change_password",
      resourceType: "user",
      resourceId: userId,
      ipAddress,
      userAgent,
      success: true,
    });

    return res.json({
      message: "Password changed successfully. Please log in again.",
    });
  } catch (err) {
    authLogger.error("Password change failed", err, {
      operation: "password_change_error",
      userId,
    });
    return res
      .status(500)
      .json({ error: "Failed to update password and re-encrypt data." });
  }
});

registerUserDataAccessRoutes(router, {
  authenticateJWT,
  authManager,
});

registerUserSessionRoutes(router, {
  authenticateJWT,
  authManager,
});

registerUserSettingsRoutes(router, authenticateJWT);
registerTlsRoutes(router, authenticateJWT);
registerBrandingRoutes(router, requireAdmin);

// Core login compatibility is retained for now; third-party login providers
// are not enabled in the v0.1 release surface.
registerAuthRoutes(router);
registerAuthCompatRoutes(router);

export default router;
