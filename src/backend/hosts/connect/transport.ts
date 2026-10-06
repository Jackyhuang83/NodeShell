/**
 * How the bytes get to a host: optional port knocking, then an optional
 * SSH jump-host chain. Sets config.sock for jump forwarding and returns the
 * jump client so the caller can close it with the connection.
 */

import type { Client } from "ssh2";
import { logger } from "../../utils/logger.js";
import { createJumpHostChain } from "../jump-host-chain.js";
import { resolveSshConnectConfigHost } from "../ssh-dns.js";
import { performPortKnocking } from "../terminal-auth-helpers.js";
import type {
  MutableConnectConfig,
  SshAuthLog,
  SshConnectHost,
  SshPromptChannel,
} from "./types.js";


class SshTransportError extends Error {
  constructor(
    message: string,
    readonly stage: "jump-host" | "jump-forward",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SshTransportError";
  }
}

export interface OpenTransportOptions {
  prompt?: SshPromptChannel;
  /** Knock before connecting when the host has a sequence. Default true. */
  portKnock?: boolean;
  /** Resolve DNS up front for a direct connection. Default true. */
  resolveDns?: boolean;
  log?: SshAuthLog;
}

export interface OpenedTransport {
  jumpClient: Client | null;
  via: "direct" | "jump";
}

function forwardThrough(
  jumpClient: Client,
  host: SshConnectHost,
): Promise<NonNullable<MutableConnectConfig["sock"]>> {
  return new Promise((resolve, reject) => {
    jumpClient.forwardOut(
      "127.0.0.1",
      0,
      host.ip,
      host.port || 22,
      (err, stream) => {
        if (err) {
          reject(
            new SshTransportError(
              "Failed to forward through jump host: " + err.message,
              "jump-forward",
              { cause: err },
            ),
          );
          return;
        }
        resolve(stream);
      },
    );
  });
}

export async function openSshTransport(
  host: SshConnectHost,
  config: MutableConnectConfig,
  options: OpenTransportOptions = {},
): Promise<OpenedTransport> {
  if (
    options.portKnock !== false &&
    Array.isArray(host.portKnockSequence) &&
    host.portKnockSequence.length > 0
  ) {
    try {
      await performPortKnocking(host.ip, host.portKnockSequence);
    } catch {
      logger.warn("Port knocking failed, attempting connection anyway", {
        operation: "port_knock",
        hostId: host.id,
      });
    }
  }

  const jumpUserId = host.userId || "";
  if (host.jumpHosts && host.jumpHosts.length > 0 && jumpUserId) {
    const jumpClient = await createJumpHostChain(
      host.jumpHosts,
      jumpUserId,
      options.prompt,
    );
    if (!jumpClient) {
      throw new SshTransportError(
        "Failed to connect through jump hosts",
        "jump-host",
      );
    }
    try {
      config.sock = await forwardThrough(jumpClient, host);
    } catch (error) {
      jumpClient.end();
      throw error;
    }
    return { jumpClient, via: "jump" };
  }

  if (options.resolveDns !== false) {
    await resolveSshConnectConfigHost(config);
  }

  return { jumpClient: null, via: "direct" };
}
