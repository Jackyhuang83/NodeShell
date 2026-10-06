/** Password verification for NodeShell's single local Owner account. */

import bcrypt from "bcryptjs";
import { authLogger } from "../utils/logger.js";
import { loginRateLimiter } from "../utils/login-rate-limiter.js";
import { createCurrentUserRepository } from "../database/repositories/factory.js";
import { LoginMethodError, type VerifiedIdentity } from "./types.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function verifyPasswordLogin(request: {
  body: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): Promise<VerifiedIdentity & { rateLimitUsername: string }> {
  const { username, password } = request.body;
  const clientIp = request.ip || request.socket?.remoteAddress || "unknown";

  if (!nonEmpty(username) || !nonEmpty(password)) {
    throw new LoginMethodError("Invalid username or password", 400);
  }

  const lockStatus = loginRateLimiter.isLocked(clientIp, username);
  if (lockStatus.locked) {
    authLogger.warn("Login attempt blocked due to rate limiting", {
      operation: "user_login_blocked",
      username,
      ip: clientIp,
      remainingTime: lockStatus.remainingTime,
    });
    const error = new LoginMethodError(
      "Too many login attempts. Please try again later.",
      429,
    );
    Object.assign(error, { remainingTime: lockStatus.remainingTime });
    throw error;
  }

  const user = await createCurrentUserRepository().findOwner();
  if (!user || user.username !== username) {
    loginRateLimiter.recordFailedAttempt(clientIp, username);
    authLogger.warn("Login failed: username is not the NodeShell owner", {
      operation: "user_login",
      username,
      ip: clientIp,
    });
    throw new LoginMethodError("Invalid username or password", 401);
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    loginRateLimiter.recordFailedAttempt(clientIp, username);
    authLogger.warn("Login failed: incorrect password", {
      operation: "user_login",
      username,
      userId: user.id,
      ip: clientIp,
    });
    throw new LoginMethodError("Invalid username or password", 401);
  }

  return {
    kind: "user",
    userId: user.id,
    password,
    rememberMe: !!request.body.rememberMe,
    rateLimitUsername: username,
  };
}
