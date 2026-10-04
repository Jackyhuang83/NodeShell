import type { Request } from "express";

/**
 * True only for a direct loopback TCP peer.
 *
 * The bundled reverse proxy always adds X-Real-IP, so a request that traversed
 * nginx is never treated as a local operator request even though nginx itself
 * connects to the backend over loopback.
 */
export function isLoopbackRequest(req: Request): boolean {
  if (req.headers["x-real-ip"]) return false;

  const ip = req.socket?.remoteAddress || "";
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.endsWith(":127.0.0.1")
  );
}
