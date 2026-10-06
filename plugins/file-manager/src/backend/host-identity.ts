import type { PluginLogger } from "@termix/plugin-sdk/backend";

export type ConnectionStage =
  | "dns"
  | "tcp"
  | "handshake"
  | "auth"
  | "connected"
  | "connection"
  | "error"
  | "proxy"
  | "jump"
  | "sftp_connecting"
  | "sftp_auth"
  | "sftp_connected";

export type LogEntry = {
  id: string;
  timestamp: Date;
  type: "info" | "success" | "warning" | "error";
  stage: ConnectionStage;
  message: string;
  details?: Record<string, unknown> | string;
};

export function createConnectionLog(
  type: LogEntry["type"],
  stage: ConnectionStage,
  message: string,
  details?: Record<string, unknown>,
): Omit<LogEntry, "id" | "timestamp"> {
  return { type, stage, message, details };
}

function normalizeHostAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase();
}

/** Whether a saved host id resolves to a different address than requested. */
export function hostAddressMismatch(
  clientAddress: unknown,
  resolvedAddress: unknown,
): boolean {
  const resolved = normalizeHostAddress(resolvedAddress);
  if (!resolved) return false;
  return resolved !== normalizeHostAddress(clientAddress);
}

export class HostAddressMismatchError extends Error {
  constructor() {
    super(
      "Host mismatch: the selected saved host resolves to a different address, so the connection was refused.",
    );
    this.name = "HostAddressMismatchError";
  }
}

export class HostNotOnThisServerError extends Error {
  constructor() {
    super(
      "The selected saved host does not exist, so the connection was refused.",
    );
    this.name = "HostNotOnThisServerError";
  }
}

type Meta = Record<string, unknown>;

export interface FileLogger {
  info: (message: string, meta?: Meta) => void;
  success: (message: string, meta?: Meta) => void;
  warn: (message: string, meta?: Meta) => void;
  error: (message: string, error?: unknown, meta?: Meta) => void;
}

function withMeta(message: string, meta?: Meta): string {
  if (!meta || Object.keys(meta).length === 0) return message;
  try {
    return `${message} ${JSON.stringify(meta)}`;
  } catch {
    return message;
  }
}

/** ctx.log takes a plain message; this keeps the structured fields readable. */
export function createFileLogger(log: PluginLogger): FileLogger {
  return {
    info: (message, meta) => log.info(withMeta(message, meta)),
    success: (message, meta) => log.info(withMeta(message, meta)),
    warn: (message, meta) => log.warn(withMeta(message, meta)),
    error: (message, error, meta) => {
      if (error instanceof Error) {
        log.error(withMeta(message, meta), error);
      } else if (error && typeof error === "object" && !meta) {
        log.error(withMeta(message, error as Meta));
      } else {
        log.error(withMeta(message, meta));
      }
    },
  };
}
