/**
 * The one place a login becomes a session: JWT, cookie, response body,
 * audit line and the user_login internal event for the local Owner.
 */

import type { Request, Response } from "express";
import { AuthManager } from "../utils/auth-manager.js";
import { authLogger } from "../utils/logger.js";
import { loginRateLimiter } from "../utils/login-rate-limiter.js";
import { logAudit, getRequestMeta } from "../utils/audit-logger.js";
import { parseUserAgent } from "../utils/user-agent-parser.js";
import { emitInternalEvent } from "../hosts/internal-events.js";
import { createCurrentSettingsRepository } from "../database/repositories/factory.js";
import type { UserRecord } from "../database/repositories/user-repository.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Cookie lifetime: 30 days when remembered, else session_timeout_hours. */
async function sessionCookieMaxAge(rememberMe: boolean): Promise<number> {
  if (rememberMe) return THIRTY_DAYS_MS;
  const value = await createCurrentSettingsRepository().get(
    "session_timeout_hours",
  );
  const hours = value ? parseInt(value, 10) || 24 : 24;
  return hours * 60 * 60 * 1000;
}

export interface IssueSessionOptions {
  methodId: string;
  rememberMe: boolean;
  /** Username the rate limiter counted attempts under, to clear them. */
  rateLimitUsername?: string;
}

export interface IssuedSession {
  token: string;
  maxAge: number;
  body: Record<string, unknown>;
}

/**
 * Mints the JWT and writes the audit line. The caller decides how the token
 * reaches the client: a JSON body with a cookie, or a redirect.
 */
export async function issueSession(
  req: Request,
  user: UserRecord,
  options: IssueSessionOptions,
): Promise<IssuedSession> {
  const authManager = AuthManager.getInstance();
  const deviceInfo = parseUserAgent(req);

  const token = await authManager.generateJWTToken(user.id, {
    rememberMe: options.rememberMe,
    deviceType: deviceInfo.type,
    deviceInfo: deviceInfo.deviceInfo,
  });

  if (options.rateLimitUsername) {
    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    loginRateLimiter.resetAttempts(clientIp, options.rateLimitUsername);
  }

  const { ipAddress, userAgent } = getRequestMeta(req);
  await logAudit({
    userId: user.id,
    username: user.username,
    action: "login",
    resourceType: "session",
    details: JSON.stringify({ method: options.methodId }),
    ipAddress,
    userAgent,
    success: true,
  });
  emitInternalEvent("user_login", user.id, undefined, {
    username: user.username,
    ipAddress,
  });

  authLogger.success("User login successful", {
    operation: "user_login_complete",
    userId: user.id,
    username: user.username,
    method: options.methodId,
  });

  const maxAge = await sessionCookieMaxAge(options.rememberMe);

  return {
    token,
    maxAge,
    body: {
      success: true,
      is_admin: !!user.isAdmin,
      username: user.username,
      userId: user.id,
      // Compatibility fields stay fixed off in the owner-only runtime.
      is_external: false,
      is_oidc: false,
      totp_enabled: false,
    },
  };
}

/** Sets the cookie and sends the body. */
export function sendSession(
  req: Request,
  res: Response,
  session: IssuedSession,
): Response {
  const authManager = AuthManager.getInstance();
  return res
    .cookie(
      "jwt",
      session.token,
      authManager.getSecureCookieOptions(req, session.maxAge),
    )
    .json(session.body);
}
