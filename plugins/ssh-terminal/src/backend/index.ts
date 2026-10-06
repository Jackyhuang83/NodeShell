import type { Router } from "express";
import type { PluginContext } from "@termix/plugin-sdk/backend";
import { createTerminalLogger } from "./helpers.js";
import { hostImportNormalizer, hostPayloadLegacy } from "./host-import.js";
import { registerTerminalRoutes } from "./routes.js";
import {
  DEFAULT_TIMEOUT_MINUTES,
  TerminalSessionManager,
} from "./session-manager.js";
import type { TmuxSessionsV1 } from "./services.js";
import { ADMIN_KEYS } from "./settings.js";
import { createTerminalSocket } from "./terminal-socket.js";
import {
  validateAdminSettings,
  validateUserSettings,
} from "./settings-validation.js";

/**
 * A service another plugin may or may not provide. The handle always exists;
 * whether its provider is up is asked through the proxy's `in` check.
 */
function optionalService<T extends object>(
  ctx: PluginContext,
  service: string,
  probe: keyof T & string,
): T | null {
  const handle = ctx.services.get<T>(service);
  return probe in handle ? handle : null;
}

export async function activate(ctx: PluginContext) {
  const log = createTerminalLogger(ctx.log);
  ctx.settings.onValidate("admin", validateAdminSettings);
  ctx.settings.onValidate("user", validateUserSettings);

  // Read on every detach, so it is kept current rather than awaited there.
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  const applyTimeout = (value: unknown) => {
    const minutes = Number(value);
    timeoutMinutes =
      Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_TIMEOUT_MINUTES;
  };
  const refreshTimeout = async () =>
    applyTimeout(await ctx.settings.get(ADMIN_KEYS.sessionTimeoutMinutes));
  await refreshTimeout();
  ctx.settings.onChange(ADMIN_KEYS.sessionTimeoutMinutes, applyTimeout);

  const sessionManager = new TerminalSessionManager({
    log,
    getTimeoutMinutes: () => timeoutMinutes,
  });
  ctx.disposables.add(() => sessionManager.destroyAll());

  const socket = createTerminalSocket({
    ctx,
    log,
    sessionManager,
    getTmux: () =>
      optionalService<TmuxSessionsV1>(ctx, "tmux.sessions", "detect"),
  });

  // NodeShell v0.1 has no anonymous terminal/session-sharing surface.
  // Core authenticates the upgrade and enforces a trusted browser Origin
  // before the terminal handler is invoked.
  ctx.ws.route("/terminal", (connection) => {
    // Also picks up a value the boot migration wrote after activation.
    void refreshTimeout().catch(() => {});
    return socket.handleConnection(connection);
  });
  ctx.disposables.add(() => socket.closeAll());

  registerTerminalRoutes(ctx.http.router<Router>({ rawBody: true }), {
    ctx,
    log,
    sessionManager,
  });

  ctx.registry.provide(
    "ssh-terminal.hostImportNormalizer",
    hostImportNormalizer,
  );
  ctx.registry.provide("ssh-terminal.hostPayloadLegacy", hostPayloadLegacy);

  ctx.log.info("SSH terminal mounted at /plugin-ws/ssh-terminal/terminal");
}

export async function deactivate() {
  // Everything above was registered through ctx and is disposed by core.
}
