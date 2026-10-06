import { websocketAuthProtocols } from "@/lib/ws-auth";
import { getBasePath } from "@/lib/base-path";

export type ConnectionOrigin = "local" | "remote";

interface OriginResolvableHost {
  connectionOrigin?: ConnectionOrigin | null;
}

/** NodeShell v0.1 has one Web backend, so every saved host uses it. */
export async function resolveConnectionOrigin(
  _host: OriginResolvableHost,
  _options: { defaultRemote?: boolean } = {},
): Promise<ConnectionOrigin> {
  return "local";
}

export interface WebSocketConnectionTarget {
  url: string;
  protocols: string[];
}

/**
 * Compatibility helper for retained connection code. There is no desktop
 * embedded backend or linked remote server in v0.1; WebSockets always target
 * the same public origin as the WebUI.
 */
export async function buildOriginWsUrl({
  localPath,
  remotePath,
  includeJwt = true,
}: {
  origin: ConnectionOrigin;
  localPort: number;
  localPath: string;
  remotePath: string;
  includeJwt?: boolean;
}): Promise<WebSocketConnectionTarget> {
  const path = remotePath || localPath;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const token = includeJwt ? localStorage.getItem("jwt") : null;
  return {
    url: `${protocol}://${window.location.host}${getBasePath()}${path}`,
    protocols: websocketAuthProtocols(token),
  };
}
