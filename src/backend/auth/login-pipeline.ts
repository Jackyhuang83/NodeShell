/**
 * NodeShell v0.1 browser login pipeline.
 *
 * Only the canonical local Owner may sign in. External identities and browser
 * second factors are intentionally outside the v0.1 runtime.
 */

import type { Request, Response } from "express";
import { AuthManager } from "../utils/auth-manager.js";
import { authLogger } from "../utils/logger.js";
import { createCurrentUserRepository } from "../database/repositories/factory.js";
import { issueSession, sendSession } from "./session-issuer.js";
import {
  LoginMethodError,
  type VerifiedIdentity,
} from "./types.js";

export interface LoginContext {
  methodId: string;
  rememberMe: boolean;
  rateLimitUsername?: string;
}

export type LoginResult = {
  kind: "session";
  token: string;
  maxAge: number;
  body: Record<string, unknown>;
};

export async function runLogin(
  req: Request,
  identity: VerifiedIdentity,
  context: LoginContext,
): Promise<LoginResult> {
  if (identity.kind !== "user") {
    throw new LoginMethodError(
      "External authentication is disabled in NodeShell v0.1",
      403,
      "external_auth_disabled",
    );
  }

  const owner = await createCurrentUserRepository().findOwner();
  if (!owner || owner.id !== identity.userId) {
    throw new LoginMethodError("Owner account not found", 401, "owner_required");
  }

  if (!identity.password) {
    throw new LoginMethodError("Owner password is required", 401);
  }

  const unlocked = await AuthManager.getInstance().authenticateUser(
    owner.id,
    identity.password,
  );
  if (!unlocked) {
    throw new LoginMethodError("Invalid username or password", 401);
  }

  const session = await issueSession(req, owner, {
    methodId: context.methodId,
    rememberMe: context.rememberMe,
    rateLimitUsername:
      context.rateLimitUsername ?? identity.rateLimitUsername,
  });
  return { kind: "session", ...session };
}

export async function respondWithLogin(
  req: Request,
  res: Response,
  identity: VerifiedIdentity,
  context: LoginContext,
): Promise<Response> {
  const result = await runLogin(req, identity, context);
  return sendSession(req, res, result);
}

export function sendLoginError(res: Response, error: unknown): Response {
  if (error instanceof LoginMethodError) {
    const remainingTime = (error as { remainingTime?: number }).remainingTime;
    return res.status(error.status).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(remainingTime !== undefined ? { remainingTime } : {}),
    });
  }
  authLogger.error("Login failed", error);
  return res.status(500).json({ error: "Login failed" });
}
