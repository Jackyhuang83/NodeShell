import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix/plugin-sdk/backend";
import { CONNECTION_STATES, type TunnelConnectRequest } from "./types.js";
import type { TunnelManager } from "./manager.js";
import { errorMessage } from "./manager.js";
import {
  RESERVED_TUNNEL_NAME_PREFIX,
  isReservedTunnelName,
  validateTunnelConfig,
} from "./utils.js";
import { authorizeTunnelAction } from "./authorize.js";
import { buildTunnelConfig } from "./config.js";

function actor(ctx: PluginContext): string {
  return ctx.currentActor() as string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPort(value: unknown, allowZero = false): boolean {
  const port = Number(value);
  return (
    Number.isInteger(port) &&
    port >= (allowZero ? 0 : 1) &&
    port <= 65535
  );
}

export function registerTunnelRoutes(
  router: Router,
  ctx: PluginContext,
  manager: TunnelManager,
): void {
  router.use(ctx.rbac.require("use") as never);

  const statusClients = new Map<Response, string>();

  const sendSnapshot = (res: Response) => {
    const userId = statusClients.get(res);
    if (userId === undefined) return;
    void manager
      .statusesFor(userId)
      .then((snapshot) => {
        res.write(`event: statuses\ndata: ${JSON.stringify(snapshot)}\n\n`);
      })
      .catch(() => statusClients.delete(res));
  };

  const unsubscribe = manager.onChange(() => {
    for (const res of statusClients.keys()) sendSnapshot(res);
  });
  ctx.disposables.add(() => {
    unsubscribe();
    for (const res of statusClients.keys()) {
      try {
        res.end();
      } catch {
        // Already closed.
      }
    }
    statusClients.clear();
  });

  const canAccess = (userId: string) => (hostId: number) =>
    manager.canAccessHost(userId, hostId);

  router.get("/status", async (_req: Request, res: Response) => {
    res.json(await manager.statusesFor(actor(ctx)));
  });

  router.get("/status/stream", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    statusClients.set(res, actor(ctx));
    sendSnapshot(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        closeStream();
      }
    }, 30_000);

    const closeStream = () => {
      clearInterval(heartbeat);
      statusClients.delete(res);
    };
    req.on("close", closeStream);
  });

  router.get("/status/:tunnelName", async (req: Request, res: Response) => {
    const tunnelName = String(req.params.tunnelName);
    if (!(await manager.canAccessTunnel(actor(ctx), tunnelName))) {
      return res.status(404).json({ error: "Tunnel not found" });
    }
    const status = manager.statuses.get(tunnelName);
    if (!status) return res.status(404).json({ error: "Tunnel not found" });
    return res.json({ name: tunnelName, status });
  });

  router.post("/connect", async (req: Request, res: Response) => {
    const userId = actor(ctx);
    const body = (req.body ?? {}) as Partial<TunnelConnectRequest>;
    const tunnelName = body.name;

    if (!isNonEmptyString(tunnelName)) {
      return res.status(400).json({ error: "Invalid tunnel configuration" });
    }
    if (isReservedTunnelName(tunnelName)) {
      return res.status(400).json({
        error: `Tunnel names beginning with "${RESERVED_TUNNEL_NAME_PREFIX}" are reserved`,
      });
    }

    const mode = body.mode ?? body.tunnelType ?? "local";
    if (mode !== "local") {
      return res.status(400).json({
        error: "NodeShell v0.1 supports Local Forward only",
      });
    }

    const sourceHostId = Number(body.sourceHostId);
    const tunnelIndex = Number(body.tunnelIndex ?? 0);
    const sourcePort = Number(body.sourcePort);
    const endpointPort = Number(body.endpointPort);
    const endpointHost = String(body.endpointHost ?? "").trim();

    if (
      !Number.isInteger(sourceHostId) ||
      sourceHostId < 1 ||
      !Number.isInteger(tunnelIndex) ||
      tunnelIndex < 0 ||
      !isPort(sourcePort, true) ||
      !isPort(endpointPort) ||
      !endpointHost
    ) {
      return res.status(400).json({ error: "Invalid tunnel configuration" });
    }

    const request: TunnelConnectRequest = {
      ...(body as TunnelConnectRequest),
      name: tunnelName,
      sourceHostId,
      tunnelIndex,
      scope: "s2s",
      mode: "local",
      tunnelType: "local",
      bindHost: "127.0.0.1",
      endpointHost,
      sourcePort,
      endpointPort,
    };

    if (
      !validateTunnelConfig(tunnelName, {
        sourceHostId,
        tunnelIndex,
        sourcePort,
        endpointHost,
        endpointPort,
      })
    ) {
      return res
        .status(400)
        .json({ error: "Tunnel configuration does not match tunnel name" });
    }

    const access = await ctx.hosts.checkAccess(sourceHostId, "connect");
    const host = access.hasAccess ? await ctx.hosts.get(sourceHostId) : null;
    if (!host) {
      return res.status(403).json({ error: "Access denied to this host" });
    }

    try {
      await manager.start(buildTunnelConfig(host, request, userId));
    } catch (error) {
      const reason = errorMessage(error);
      ctx.log.warn(`Tunnel ${tunnelName} could not start: ${reason}`);
      manager.broadcast(tunnelName, {
        connected: false,
        status: CONNECTION_STATES.FAILED,
        reason,
      });
    }

    return res.json({ message: "Connection request received", tunnelName });
  });

  const stopHandler =
    (message: string) => async (req: Request, res: Response) => {
      const userId = actor(ctx);
      const tunnelName = (req.body ?? {}).tunnelName;
      if (!isNonEmptyString(tunnelName)) {
        return res.status(400).json({ error: "Tunnel name required" });
      }

      const decision = await authorizeTunnelAction(
        canAccess(userId),
        tunnelName,
        manager.configs.get(tunnelName),
      );
      if (!decision.allowed) {
        return res.status(403).json({ error: "Access denied" });
      }

      await manager.stop(tunnelName);
      return res.json({ message, tunnelName });
    };

  router.post("/disconnect", stopHandler("Disconnect request received"));
  router.post("/cancel", stopHandler("Cancel request received"));
}
