import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { SystemCrypto } from "../../utils/system-crypto.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { authLogger } from "../../utils/logger.js";
import { isLoopbackRequest } from "./desktop-auto-session.js";
import {
  createCurrentRoleRepository,
  createCurrentUserRepository,
} from "../repositories/factory.js";
import { resetUserPassword } from "./user-password-reset-routes.js";

const router = express.Router();
const MIN_PASSWORD_LENGTH = 12;

function bearerToken(req: Request): string {
  const header = req.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function requireLocalInternalAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ error: "Local access required" });
  }

  const supplied = bearerToken(req);
  const expected = await SystemCrypto.getInstance().getInternalAuthToken();
  if (!supplied || !constantTimeEqual(supplied, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

router.use(requireLocalInternalAdmin);

router.get("/status", async (_req, res) => {
  const users = await createCurrentUserRepository().listAll();
  const owner = users.find((user) => user.isAdmin) ?? null;
  res.json({
    initialized: users.length > 0,
    userCount: users.length,
    owner: owner ? { username: owner.username } : null,
  });
});

router.post("/create-owner", async (req, res) => {
  const username =
    typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password =
    typeof req.body?.password === "string" ? req.body.password : "";

  if (!username || username.length > 128) {
    return res.status(400).json({ error: "A valid username is required" });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  const userRepository = createCurrentUserRepository();
  if ((await userRepository.countAll()) !== 0) {
    return res.status(409).json({
      error: "NodeShell is already initialized; create-owner is closed",
    });
  }

  const id = nanoid();
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { user, isFirstUser } = await userRepository.createFirstLocalUser({
      id,
      username,
      passwordHash,
      isOidc: false,
      clientId: "",
      clientSecret: "",
      issuerUrl: "",
      authorizationUrl: "",
      tokenUrl: "",
      identifierPath: "",
      namePath: "",
      scopes: "openid email profile",
    });

    if (!isFirstUser || !user.isAdmin) {
      await userRepository.delete(id);
      return res.status(409).json({
        error: "Owner creation raced with another initialization attempt",
      });
    }

    const roleAssigned =
      await createCurrentRoleRepository().assignRoleNameToUser({
        userId: id,
        roleName: "admin",
        grantedBy: id,
      });
    if (!roleAssigned) {
      await userRepository.delete(id);
      throw new Error("Admin role is unavailable");
    }

    await AuthManager.getInstance().registerUser(id, password);

    authLogger.success("NodeShell owner created through local admin channel", {
      operation: "nodeshell_owner_create",
      userId: id,
      username,
    });

    return res.status(201).json({ success: true, username });
  } catch (error) {
    await userRepository.delete(id).catch(() => false);
    authLogger.error("Local owner creation failed", error, {
      operation: "nodeshell_owner_create_failed",
      username,
    });
    return res.status(500).json({ error: "Failed to create owner" });
  }
});

router.post("/reset-password", async (req, res) => {
  const username =
    typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const newPassword =
    typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
  const confirmDataWipe = req.body?.confirmDataWipe === true;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  const user = await createCurrentUserRepository().findByUsername(username);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  if (user.isOidc) {
    return res.status(409).json({
      error: "Password recovery is not available for external-auth users",
    });
  }

  const authManager = AuthManager.getInstance();
  try {
    await authManager.unlockWithSystemKey(user.id);
  } catch {
    // Legacy password-wrapped DEKs may not be unlockable without the old
    // password. resetUserPassword will fail closed unless the operator
    // explicitly confirms a destructive data wipe.
  }

  const outcome = await resetUserPassword(authManager, {
    userId: user.id,
    username: user.username,
    newPassword,
    confirmDataWipe,
  });

  if (outcome.status === "wipe_confirmation_required") {
    return res.status(409).json({
      error:
        "The encrypted data key cannot be recovered without the old password",
      requiresDataWipe: true,
    });
  }

  authLogger.warn("NodeShell password reset through local admin channel", {
    operation: "nodeshell_password_reset",
    userId: user.id,
    username: user.username,
    dataWiped: outcome.dataWiped,
  });

  return res.json({
    success: true,
    username: user.username,
    dataWiped: outcome.dataWiped,
  });
});

export default router;
