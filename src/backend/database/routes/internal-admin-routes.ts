import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { AuthManager } from "../../utils/auth-manager.js";
import { SystemCrypto } from "../../utils/system-crypto.js";
import { authLogger } from "../../utils/logger.js";
import { createCurrentUserRepository } from "../repositories/factory.js";
import { isLoopbackRequest } from "../../utils/loopback-request.js";
import { resetUserPassword } from "./user-password-reset-routes.js";

const router = express.Router();
const MIN_PASSWORD_LENGTH = 12;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function bearerToken(req: Request): string {
  const value = req.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function requireLocalInternalAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // X-Real-IP is set by the bundled reverse proxy, so a browser request that
  // traverses nginx is rejected even though nginx itself connects on loopback.
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ error: "Local access required" });
  }

  const supplied = bearerToken(req);
  const expected = await SystemCrypto.getInstance().getInternalAuthToken();
  if (!supplied || !timingSafeTextEqual(supplied, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

router.use(requireLocalInternalAdmin);

router.get("/status", async (_req, res) => {
  const userRepository = createCurrentUserRepository();
  const [owner, userCount] = await Promise.all([
    userRepository.findOwner(),
    userRepository.countAll(),
  ]);
  return res.json({
    initialized: userCount > 0,
    userCount,
    owner: owner ? { username: owner.username } : null,
  });
});

router.post("/create-owner", async (req, res) => {
  const username =
    typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password =
    typeof req.body?.password === "string" ? req.body.password : "";

  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({
      error:
        "Username must be 1-64 characters using letters, digits, dot, underscore or dash",
    });
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

  const id = crypto.randomUUID();
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

  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: "A valid owner username is required" });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }

  const user = await createCurrentUserRepository().findOwner();
  if (!user || user.username !== username) {
    return res.status(404).json({ error: "Owner account not found" });
  }

  const authManager = AuthManager.getInstance();
  try {
    // A current v3 DEK is server-wrapped and can be recovered after restart.
    // Legacy password-wrapped DEKs remain locked without the old password.
    await authManager.unlockWithSystemKey(user.id);
  } catch {
    // resetUserPassword fails closed below unless destructive recovery is
    // explicitly confirmed.
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
        "The legacy encrypted data key cannot be recovered without the old password",
      requiresDataWipe: true,
    });
  }

  authLogger.warn("NodeShell Owner password reset through local admin channel", {
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
