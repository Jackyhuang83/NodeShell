import { createServer, Socket, type Server } from "node:net";
import type { Client, ClientChannel } from "ssh2";
import type {
  PluginContext,
  PluginSshConnection,
} from "@termix/plugin-sdk/backend";
import {
  CONNECTION_STATES,
  type TunnelConfig,
  type TunnelStatus,
} from "./types.js";
import { forwardOut, pipeTunnelStreams } from "./ssh-primitives.js";
import {
  classifyTunnelError,
  getTunnelBindHost,
  getTunnelMode,
  isReservedTunnelName,
} from "./utils.js";

export interface TunnelRuntime {
  sourceClient: Client;
  endpointClient?: Client;
  bindHost: string;
  bindPort: number;
  close: () => void;
}

/** A status snapshot as a user sees it, keyed by tunnel name. */
export type TunnelStatusMap = Record<string, TunnelStatus>;

const CONNECT_TIMEOUT_MS = 60_000;
const MANUAL_DISCONNECT_HOLD_MS = 5_000;
const ACCESS_CACHE_MS = 60_000;

export function errorMessage(
  error: unknown,
  fallback = "Unknown error",
): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

export type TunnelManager = ReturnType<typeof createTunnelManager>;

/**
 * Every running tunnel and its retry state, created fresh in activate so a
 * disable-then-enable starts clean.
 *
 * Both SSH legs go through ctx.ssh.connect, so tunnels get host key checks,
 * auth providers, proxies and jump hosts the same way every other transport
 * does. The endpoint leg of a source-to-endpoint tunnel is opened over a
 * forwardOut channel on the source connection, handed to ctx.ssh as `sock`.
 */
export function createTunnelManager(ctx: PluginContext) {
  const log = ctx.log;

  const configs = new Map<string, TunnelConfig>();
  const statuses = new Map<string, TunnelStatus>();
  const runtimes = new Map<string, TunnelRuntime>();
  const retryCounters = new Map<string, number>();
  const retryTimers = new Map<string, NodeJS.Timeout>();
  const countdownTimers = new Map<string, NodeJS.Timeout>();
  const manualDisconnects = new Set<string>();
  const manualHoldTimers = new Set<NodeJS.Timeout>();
  const retryExhausted = new Set<string>();
  const cleanupInProgress = new Set<string>();
  const connecting = new Set<string>();
  const lastErrors = new Map<string, string>();
  const lastErrorTypes = new Map<string, TunnelStatus["errorType"]>();
  const pendingOperations = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const accessCache = new Map<string, { allowed: boolean; at: number }>();
  let disposed = false;

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log.warn(`Tunnel status listener failed: ${errorMessage(error)}`);
      }
    }
  }

  function broadcast(name: string, status: TunnelStatus): void {
    if (
      status.status === CONNECTION_STATES.CONNECTED &&
      retryTimers.has(name)
    ) {
      return;
    }

    const next = { ...status };

    if (retryExhausted.has(name) && next.status === CONNECTION_STATES.FAILED) {
      const previous = lastErrors.get(name);
      next.reason = previous
        ? `Max retries exhausted: ${previous}`
        : "Max retries exhausted";
    }

    if (next.status === CONNECTION_STATES.FAILED && next.reason) {
      lastErrors.set(name, next.reason);
      if (next.errorType) lastErrorTypes.set(name, next.errorType);
    } else if (
      (next.status === CONNECTION_STATES.CONNECTING ||
        next.status === CONNECTION_STATES.RETRYING ||
        next.status === CONNECTION_STATES.WAITING) &&
      !next.reason
    ) {
      next.reason = lastErrors.get(name);
      next.errorType = lastErrorTypes.get(name);
    } else if (
      next.status === CONNECTION_STATES.CONNECTED ||
      (next.status === CONNECTION_STATES.DISCONNECTED && next.manualDisconnect)
    ) {
      lastErrors.delete(name);
      lastErrorTypes.delete(name);
    }

    statuses.set(name, next);
    ctx.events.emit("plugin.tunnels.status", {
      name,
      sourceHostId: configs.get(name)?.sourceHostId,
      status: next,
    });
    notify();
  }

  function clearRetryTimers(name: string): void {
    const retry = retryTimers.get(name);
    if (retry) {
      clearTimeout(retry);
      retryTimers.delete(name);
    }
    const countdown = countdownTimers.get(name);
    if (countdown) {
      clearInterval(countdown);
      countdownTimers.delete(name);
    }
  }

  function resetRetryState(name: string): void {
    retryCounters.delete(name);
    retryExhausted.delete(name);
    lastErrors.delete(name);
    lastErrorTypes.delete(name);
    cleanupInProgress.delete(name);
    connecting.delete(name);
    clearRetryTimers(name);
  }

  async function cleanup(name: string, force = false): Promise<void> {
    if (cleanupInProgress.has(name)) return;
    if (!force && connecting.has(name)) return;

    cleanupInProgress.add(name);
    const runtime = runtimes.get(name);
    if (runtime) {
      runtimes.delete(name);
      try {
        runtime.close();
      } catch (error) {
        log.error(
          `Error while closing tunnel ${name}`,
          error instanceof Error ? error : undefined,
        );
      }
    }
    cleanupInProgress.delete(name);
    clearRetryTimers(name);
  }

  /** One SSH leg, as the tunnel's owner, through core's connect pipeline. */
  async function openLeg(
    userId: string,
    hostId: number,
    sock?: ClientChannel,
  ): Promise<PluginSshConnection<Client>> {
    return ctx.asUser(userId, () =>
      ctx.ssh.connect<Client>(hostId, {
        purpose: "tunnel",
        profile: "forward",
        timeoutMs: CONNECT_TIMEOUT_MS,
        sock,
      }),
    );
  }

  function directTargetHost(config: TunnelConfig): string {
    const target = config.targetHost?.trim();
    if (target) return target;
    if (
      config.endpointHostId !== undefined &&
      config.endpointHostId === config.sourceHostId
    ) {
      return "127.0.0.1";
    }
    return config.endpointHost || "127.0.0.1";
  }

  async function establish(config: TunnelConfig): Promise<TunnelRuntime> {
    if (getTunnelMode(config) !== "local") {
      throw new Error("NodeShell v0.1 supports Local Forward only");
    }

    const source = await openLeg(config.requestingUserId, config.sourceHostId);
    const sourceClient = source.client;
    const name = config.name;
    const bindHost = getTunnelBindHost(config);
    const targetHost = directTargetHost(config);
    const targetPort = config.endpointPort;
    const sockets = new Set<Socket>();

    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        sockets.delete(socket);
        socket.destroy();
      });

      forwardOut(sourceClient, targetHost, targetPort)
        .then((outbound) =>
          pipeTunnelStreams(socket, Promise.resolve(outbound), name, log),
        )
        .catch(() => socket.destroy());
    });

    try {
      const boundPort = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: bindHost, port: config.sourcePort }, () => {
          server.removeListener("error", reject);
          resolve((server.address() as { port: number }).port);
        });
      });

      let idleTimer: NodeJS.Timeout | undefined;
      const close = () => {
        if (idleTimer) clearInterval(idleTimer);
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close();
        source.dispose();
      };

      if (config.idleTimeoutMs && config.idleTimeoutMs > 0) {
        const idleTimeoutMs = config.idleTimeoutMs;
        let idleSince: number | null = Date.now();
        idleTimer = setInterval(
          () => {
            if (sockets.size > 0) {
              idleSince = null;
              return;
            }
            if (idleSince === null) {
              idleSince = Date.now();
              return;
            }
            if (Date.now() - idleSince < idleTimeoutMs) return;
            if (runtimes.get(name)?.sourceClient !== sourceClient) return;
            log.info(`Closing idle tunnel ${name}`);
            void cleanup(name, true);
          },
          Math.min(30_000, idleTimeoutMs),
        );
        idleTimer.unref();
      }

      log.info(
        `Local tunnel ${name} listening on ${bindHost}:${boundPort} to ${targetHost}:${targetPort}`,
      );

      return { sourceClient, bindHost, bindPort: boundPort, close };
    } catch (error) {
      for (const socket of sockets) socket.destroy();
      server.close();
      source.dispose();
      throw error;
    }
  }

  /** Reacts to the source connection dropping after the tunnel was up. */
  function watch(runtime: TunnelRuntime, config: TunnelConfig): void {
    const name = config.name;
    const client = runtime.sourceClient;
    client.on("error", (error: Error) => {
      log.warn(`Tunnel ${name} connection error: ${error.message}`);
    });
    client.once("close", () => {
      if (runtimes.get(name)?.sourceClient !== client) return;
      if (retryTimers.has(name)) return;
      if (!manualDisconnects.has(name)) {
        const current = statuses.get(name);
        if (current?.status !== CONNECTION_STATES.FAILED) {
          broadcast(name, {
            connected: false,
            status: CONNECTION_STATES.DISCONNECTED,
          });
        }
      }
      void handleDisconnect(name, config, !manualDisconnects.has(name), client);
    });
  }

  async function handleDisconnect(
    name: string,
    config: TunnelConfig | null,
    shouldRetry = true,
    closingClient?: Client,
  ): Promise<void> {
    if (isReservedTunnelName(name)) {
      // On-demand tunnels are reopened by whoever needs them, never retried
      // here. A deferred close for a client that a reopen already replaced
      // must not tear down the replacement.
      const current = runtimes.get(name);
      if (closingClient && current && current.sourceClient !== closingClient) {
        return;
      }
      await cleanup(name, true);
      return;
    }

    while (cleanupInProgress.has(name)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await cleanup(name);

    if (manualDisconnects.has(name)) {
      resetRetryState(name);
      broadcast(name, {
        connected: false,
        status: CONNECTION_STATES.DISCONNECTED,
        manualDisconnect: true,
      });
      return;
    }

    // Past the manual branch, so this is a drop nobody asked for.
    if (config?.requestingUserId) {
      ctx.events.emit("plugin.tunnels.tunnel_disconnected", {
        userId: config.requestingUserId,
        hostId: config.sourceHostId,
        tunnelName: name,
      });
    }

    if (retryExhausted.has(name)) {
      broadcast(name, {
        connected: false,
        status: CONNECTION_STATES.FAILED,
        reason: "Max retries already exhausted",
      });
      return;
    }

    if (retryTimers.has(name) || disposed) return;

    if (!shouldRetry || !config) {
      // Keep the reason the failure was just reported with.
      broadcast(name, {
        connected: false,
        status: CONNECTION_STATES.FAILED,
        reason: lastErrors.get(name),
        errorType: lastErrorTypes.get(name),
      });
      return;
    }

    const maxRetries = config.maxRetries || 3;
    const retryInterval = config.retryInterval || 5000;
    const retryCount = (retryCounters.get(name) || 0) + 1;

    if (retryCount > maxRetries) {
      log.error(`All ${maxRetries} retries failed for ${name}`);
      retryExhausted.add(name);
      retryCounters.delete(name);
      broadcast(name, {
        connected: false,
        status: CONNECTION_STATES.FAILED,
        retryExhausted: true,
        reason: "Max retries exhausted",
      });
      return;
    }

    retryCounters.set(name, retryCount);
    broadcast(name, {
      connected: false,
      status: CONNECTION_STATES.RETRYING,
      retryCount,
      maxRetries,
      nextRetryIn: retryInterval / 1000,
    });

    let nextRetryIn = Math.ceil(retryInterval / 1000);
    broadcast(name, {
      connected: false,
      status: CONNECTION_STATES.WAITING,
      retryCount,
      maxRetries,
      nextRetryIn,
    });

    countdownTimers.set(
      name,
      setInterval(() => {
        nextRetryIn--;
        if (nextRetryIn > 0) {
          broadcast(name, {
            connected: false,
            status: CONNECTION_STATES.WAITING,
            retryCount,
            maxRetries,
            nextRetryIn,
          });
        }
      }, 1000),
    );

    retryTimers.set(
      name,
      setTimeout(() => {
        clearRetryTimers(name);
        if (!manualDisconnects.has(name)) {
          void connect(config, retryCount);
        }
      }, retryInterval),
    );
  }

  /**
   * Opens a tunnel. Failures are reported over the status broadcast and
   * retried there, so by default this never rejects. `throwOnError` is for a
   * caller that waits on the result (forward()), which gets the runtime back.
   */
  async function connect(
    config: TunnelConfig,
    retryAttempt = 0,
    options: { throwOnError?: boolean } = {},
  ): Promise<TunnelRuntime | null> {
    const name = config.name;
    if (manualDisconnects.has(name) || disposed) return null;

    connecting.add(name);
    await cleanup(name, true);

    if (retryAttempt === 0) {
      retryExhausted.delete(name);
      retryCounters.delete(name);
    }

    const current = statuses.get(name);
    if (!current || current.status !== CONNECTION_STATES.WAITING) {
      broadcast(name, {
        connected: false,
        status: CONNECTION_STATES.CONNECTING,
        retryCount: retryAttempt > 0 ? retryAttempt : undefined,
      });
    }

    try {
      const runtime = await establish(config);
      connecting.delete(name);

      if (manualDisconnects.has(name) || disposed) {
        runtime.close();
        return null;
      }

      runtimes.set(name, runtime);
      watch(runtime, config);
      broadcast(name, { connected: true, status: CONNECTION_STATES.CONNECTED });
      return runtime;
    } catch (error) {
      connecting.delete(name);
      const message = errorMessage(error, "Failed to create tunnel");
      const errorType = classifyTunnelError(message);
      log.error(
        `Tunnel ${name} failed to connect: ${message}`,
        error instanceof Error ? error : undefined,
      );

      if (!manualDisconnects.has(name)) {
        broadcast(name, {
          connected: false,
          status: CONNECTION_STATES.FAILED,
          errorType,
          reason: message,
        });
      }

      const shouldNotRetry =
        errorType === "AUTHENTICATION_FAILED" ||
        errorType === "CONNECTION_FAILED" ||
        manualDisconnects.has(name) ||
        options.throwOnError === true;
      await handleDisconnect(name, config, !shouldNotRetry);

      if (options.throwOnError) throw error;
      return null;
    }
  }

  /** Stops a tunnel on request. Holds off retries for a few seconds. */
  async function stop(name: string): Promise<void> {
    const config = configs.get(name) ?? null;
    manualDisconnects.add(name);
    retryCounters.delete(name);
    retryExhausted.delete(name);
    clearRetryTimers(name);

    await cleanup(name, true);
    broadcast(name, {
      connected: false,
      status: CONNECTION_STATES.DISCONNECTED,
      manualDisconnect: true,
    });
    await handleDisconnect(name, config, false);

    const hold = setTimeout(() => {
      manualHoldTimers.delete(hold);
      manualDisconnects.delete(name);
    }, MANUAL_DISCONNECT_HOLD_MS);
    manualHoldTimers.add(hold);
  }

  /**
   * Starts a configured tunnel by name, waiting for any operation already in
   * flight for it first. The start itself is not awaited: its outcome comes
   * back over the status stream.
   */
  async function start(config: TunnelConfig): Promise<void> {
    const name = config.name;
    const pending = pendingOperations.get(name);
    if (pending) {
      await pending.catch(() => undefined);
    }

    const existing = configs.get(name);
    if (
      existing &&
      (existing.sourceHostId !== config.sourceHostId ||
        existing.tunnelIndex !== config.tunnelIndex)
    ) {
      throw new Error(`Tunnel name collision detected: ${name}`);
    }

    manualDisconnects.delete(name);
    retryCounters.delete(name);
    retryExhausted.delete(name);
    configs.set(name, config);

    const operation = connect(config, 0).then(() => undefined);
    pendingOperations.set(name, operation);
    void operation.finally(() => {
      if (pendingOperations.get(name) === operation) {
        pendingOperations.delete(name);
      }
    });
  }

  /** Whether `userId` can reach `hostId`, cached briefly so broadcasts stay cheap. */
  async function canAccessHost(
    userId: string,
    hostId: number,
  ): Promise<boolean> {
    const cacheKey = `${userId}:${hostId}`;
    const cached = accessCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_MS) {
      return cached.allowed;
    }
    let allowed = false;
    try {
      const access =
        ctx.currentActor() === userId
          ? await ctx.hosts.checkAccess(hostId, "connect")
          : await ctx.asUser(userId, () =>
              ctx.hosts.checkAccess(hostId, "connect"),
            );
      allowed = access.hasAccess;
    } catch {
      allowed = false;
    }
    accessCache.set(cacheKey, { allowed, at: Date.now() });
    return allowed;
  }

  /**
   * Status of every tunnel whose source host the user can reach. Names carry
   * host labels and endpoints and errors can name internal hosts, so nothing
   * else is shown. On-demand tunnels are never listed.
   */
  async function statusesFor(userId: string): Promise<TunnelStatusMap> {
    const result: TunnelStatusMap = {};
    for (const [name, status] of statuses) {
      if (isReservedTunnelName(name)) continue;
      const hostId = configs.get(name)?.sourceHostId;
      if (hostId === undefined) continue;
      if (await canAccessHost(userId, hostId)) result[name] = status;
    }
    return result;
  }

  async function canAccessTunnel(
    userId: string,
    name: string,
  ): Promise<boolean> {
    const hostId = configs.get(name)?.sourceHostId;
    if (hostId === undefined) return false;
    return canAccessHost(userId, hostId);
  }

  function onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose(): void {
    disposed = true;
    for (const name of [...runtimes.keys()]) {
      const runtime = runtimes.get(name);
      runtimes.delete(name);
      try {
        runtime?.close();
      } catch {
        // Already gone.
      }
    }
    for (const name of [...retryTimers.keys(), ...countdownTimers.keys()]) {
      clearRetryTimers(name);
    }
    for (const hold of manualHoldTimers) clearTimeout(hold);
    manualHoldTimers.clear();
    listeners.clear();
  }

  return {
    configs,
    statuses,
    runtimes,
    manualDisconnects,
    connecting,
    broadcast,
    cleanup,
    connect,
    start,
    stop,
    handleDisconnect,
    statusesFor,
    canAccessHost,
    canAccessTunnel,
    onChange,
    dispose,
  };
}
