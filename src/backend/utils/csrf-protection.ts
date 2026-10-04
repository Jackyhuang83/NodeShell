import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getRequestOrigin } from "./request-origin.js";

const COOKIE_NAME = "nodeshell_csrf";
const HEADER_NAME = "x-nodeshell-csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function secureCookie(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function safeEqual(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  );
}

export function createCsrfProtection() {
  return (req: Request, res: Response, next: NextFunction) => {
    let cookieToken =
      typeof req.cookies?.[COOKIE_NAME] === "string"
        ? req.cookies[COOKIE_NAME]
        : "";

    if (!cookieToken) {
      cookieToken = crypto.randomBytes(32).toString("base64url");
      res.cookie(COOKIE_NAME, cookieToken, {
        httpOnly: false,
        secure: secureCookie(req),
        sameSite: "strict",
        path: "/",
      });
    }

    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();

    if (req.headers.authorization?.startsWith("Bearer ")) return next();

    const fetchSite = req.get("Sec-Fetch-Site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return res.status(403).json({ error: "Cross-site request blocked" });
    }

    const origin = req.get("Origin");
    if (!origin || origin !== getRequestOrigin(req)) {
      return res.status(403).json({ error: "Invalid request origin" });
    }

    const headerToken = req.get(HEADER_NAME) ?? "";
    if (!safeEqual(cookieToken, headerToken)) {
      return res.status(403).json({ error: "Invalid CSRF token" });
    }

    next();
  };
}
