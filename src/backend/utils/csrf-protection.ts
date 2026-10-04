import type { NextFunction, Request, Response } from "express";
import { getRequestOrigin } from "./request-origin.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hasSessionCookie(req: Request): boolean {
  const cookie = req.headers.cookie;
  return typeof cookie === "string" && /(?:^|;\s*)jwt=/.test(cookie);
}

export function createCsrfProtectionMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();

    // API clients authenticate with an Authorization header rather than an
    // ambient browser cookie, so they are outside the browser-CSRF threat
    // model. Authentication and authorization still apply downstream.
    if (req.headers.authorization) return next();

    const fetchSite = req.get("sec-fetch-site")?.toLowerCase();
    if (fetchSite === "cross-site") {
      return res.status(403).json({ error: "Cross-site request blocked" });
    }

    const origin = req.get("origin");
    if (origin) {
      if (origin !== getRequestOrigin(req)) {
        return res.status(403).json({ error: "Origin validation failed" });
      }
      return next();
    }

    // Cookie-authenticated state changes without an Origin header are
    // rejected. Credential-login/bootstrap requests have no session cookie
    // yet and remain usable from local CLI/setup flows.
    if (hasSessionCookie(req)) {
      return res.status(403).json({ error: "Origin header required" });
    }

    return next();
  };
}
