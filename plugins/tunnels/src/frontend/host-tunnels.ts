import type { PluginHostRecord } from "@termix/plugin-sdk/frontend";
import type { TunnelConnectRequest, TunnelConnection } from "../shared/types";
import { serverTunnelName } from "../shared/tunnel-naming";

/** A host's tunnel settings, as the host payload's pluginSettings carries them. */
export function hostTunnelSettings(host: PluginHostRecord | null | undefined): {
  enabled: boolean;
  connections: TunnelConnection[];
} {
  const settings = (
    host?.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.tunnels;
  return {
    enabled: settings?.enableTunnel === true,
    connections: parseConnections(settings?.tunnelConnections),
  };
}

export function parseConnections(value: unknown): TunnelConnection[] {
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

export function tunnelMode(
  _tunnel: Pick<TunnelConnection, "mode" | "tunnelType">,
): "local" | "remote" | "dynamic" {
  return "local";
}

/** What POST /connect takes for a host's saved tunnel. */
export function connectRequestFor(
  host: {
    id: string | number;
    name?: string | null;
    username?: string | null;
    ip: string;
  },
  index: number,
  tunnel: TunnelConnection,
): TunnelConnectRequest {
  return {
    name: serverTunnelName(host, index, tunnel),
    sourceHostId: Number(host.id),
    tunnelIndex: index,
    scope: "s2s",
    mode: "local",
    tunnelType: "local",
    bindHost: "127.0.0.1",
    targetHost: tunnel.targetHost,
    endpointHost: (tunnel.endpointHost ?? "").trim(),
    sourcePort: tunnel.sourcePort,
    endpointPort: tunnel.endpointPort ?? 0,
    maxRetries: tunnel.maxRetries,
    retryInterval: tunnel.retryInterval,
    autoStart: tunnel.autoStart,
  };
}
