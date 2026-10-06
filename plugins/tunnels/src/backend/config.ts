import type {
  PluginContext,
  PluginHostSummary,
} from "@termix/plugin-sdk/backend";
import type {
  TunnelConfig,
  TunnelConnectRequest,
  TunnelConnection,
} from "./types.js";
import { serverTunnelName } from "../shared/tunnel-naming.js";
import { parseTunnelName } from "./utils.js";

export function hostLabel(host: {
  name?: string | null;
  username: string;
  ip: string;
}): string {
  return host.name || `${host.username}@${host.ip}`;
}

/** The name a host's saved tunnel runs under. */
export function savedTunnelName(
  host: PluginHostSummary,
  index: number,
  connection: Pick<
    TunnelConnection,
    "sourcePort" | "endpointHost" | "endpointPort"
  >,
): string {
  return serverTunnelName(host, index, connection);
}

/**
 * Builds the runtime config for a tunnel from what the client or a host's
 * saved list says about it. Credentials are never part of it: both legs
 * resolve theirs through ctx.ssh as `userId`.
 */
export function buildTunnelConfig(
  host: PluginHostSummary,
  request: Omit<TunnelConnectRequest, "sourceHostId">,
  userId: string,
): TunnelConfig {
  return {
    name: request.name,
    scope: "s2s",
    mode: "local",
    tunnelType: "local",
    bindHost: "127.0.0.1",
    targetHost: request.targetHost,
    sourceHostId: host.id,
    tunnelIndex: request.tunnelIndex,
    requestingUserId: userId,
    hostName: hostLabel(host),
    sourceIP: host.ip,
    sourceSSHPort: host.port,
    sourceUsername: host.username,
    endpointHost: (request.endpointHost ?? "").trim(),
    sourcePort: Number(request.sourcePort),
    endpointPort: Number(request.endpointPort),
    maxRetries: Number(request.maxRetries) || 3,
    retryInterval: (Number(request.retryInterval) || 5) * 1000,
    autoStart: false,
  };
}

export function connectionToRequest(
  host: PluginHostSummary,
  index: number,
  connection: TunnelConnection,
): Omit<TunnelConnectRequest, "sourceHostId"> {
  return {
    name: savedTunnelName(host, index, connection),
    tunnelIndex: index,
    scope: "s2s",
    mode: "local",
    tunnelType: "local",
    bindHost: "127.0.0.1",
    targetHost: connection.targetHost,
    endpointHost: connection.endpointHost,
    sourcePort: connection.sourcePort,
    endpointPort: connection.endpointPort,
    maxRetries: connection.maxRetries,
    retryInterval: connection.retryInterval,
    autoStart: false,
  };
}

/** A host's saved Local Forward list. */
export function readTunnelConnections(value: unknown): TunnelConnection[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? (parsed as TunnelConnection[]) : [];
}

/**
 * The saved tunnel a name points at, for starting one by name alone
 * (automations). Must run as the user it is for.
 */
export async function findSavedTunnel(
  ctx: PluginContext,
  name: string,
): Promise<{
  host: PluginHostSummary;
  index: number;
  connection: TunnelConnection;
} | null> {
  const parsed = parseTunnelName(name);
  if (parsed.isLegacyFormat || parsed.hostId === undefined) return null;
  const index = parsed.tunnelIndex ?? -1;

  const host = await ctx.hosts.get(parsed.hostId);
  if (!host) return null;
  if (!(await ctx.settings.getHost<boolean>(host.id, "enableTunnel"))) {
    return null;
  }

  const connections = readTunnelConnections(
    await ctx.settings.getHost(host.id, "tunnelConnections"),
  );
  const connection = connections[index];
  if (!connection) return null;
  if (savedTunnelName(host, index, connection) !== name) return null;
  return { host, index, connection };
}
