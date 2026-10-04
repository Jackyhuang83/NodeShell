import type { Router } from "express";
import type { PluginContext } from "@termix/plugin-sdk/backend";
import { createTunnelManager } from "./manager.js";
import { registerTunnelRoutes } from "./routes.js";
import { createTunnelsService } from "./service.js";

export type {
  TunnelsAccess,
  TunnelForwardHandle,
  TunnelForwardTarget,
} from "./service.js";

export async function activate(ctx: PluginContext) {
  const manager = createTunnelManager(ctx);
  ctx.disposables.add(() => manager.dispose());

  registerTunnelRoutes(ctx.http.router<Router>(), ctx, manager);
  ctx.services.provide("tunnels.access", createTunnelsService(ctx, manager));

  ctx.log.info("NodeShell Local Forward routes mounted");
}

export async function deactivate() {
  // Everything above was registered through ctx and is disposed by core.
}
