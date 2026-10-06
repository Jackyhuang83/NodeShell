import { randomUUID } from "crypto";
import { type Client, type ClientChannel } from "ssh2";
import { WebSocket } from "ws";
import type { TerminalLogger } from "./helpers.js";

const MAX_BUFFER_BYTES = 512 * 1024;
export const DEFAULT_TIMEOUT_MINUTES = 30;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const MAX_SESSIONS_PER_USER = 10;
export interface TerminalSession {
  id: string;
  userId: string;
  hostId: number;
  hostName: string;
  tabInstanceId?: string;
  attachedTabInstanceId?: string;

  sshConn: Client | null;
  sshStream: ClientChannel | null;
  jumpClient: Client | null;

  cols: number;
  rows: number;
  isConnected: boolean;
  createdAt: number;

  ownerWs: WebSocket | null;
  lastDetachedAt: number | null;
  detachTimeout: NodeJS.Timeout | null;

  outputBuffer: string[];
  outputBufferBytes: number;
  tmuxSessionName: string | null;
}

export interface SessionManagerDeps {
  log: TerminalLogger;
  /** Minutes a detached session is kept; read on every detach. */
  getTimeoutMinutes: () => number;
}

export class TerminalSessionManager {
  private sessions = new Map<string, TerminalSession>();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private readonly log: TerminalLogger;

  constructor(private readonly deps: SessionManagerDeps) {
    this.log = deps.log;
    this.healthCheckTimer = setInterval(
      () => this.healthCheck(),
      HEALTH_CHECK_INTERVAL_MS,
    );
  }

  createSession(
    userId: string,
    hostId: number,
    hostName: string,
    cols: number,
    rows: number,
    tabInstanceId?: string,
  ): string {
    const userSessions = this.getUserSessions(userId);
    if (userSessions.length >= MAX_SESSIONS_PER_USER) {
      const detached = userSessions
        .filter((s) => !s.ownerWs || s.ownerWs.readyState !== WebSocket.OPEN)
        .sort(
          (a, b) =>
            (a.lastDetachedAt ?? a.createdAt) -
            (b.lastDetachedAt ?? b.createdAt),
        );
      if (detached.length > 0) {
        this.destroySession(detached[0].id);
      }
    }

    if (tabInstanceId) {
      const tabSessions = userSessions.filter(
        (s) => s.tabInstanceId === tabInstanceId,
      );
      for (const existing of tabSessions) {
        const isLiveSession =
          existing.isConnected &&
          existing.sshStream != null &&
          !existing.sshStream.destroyed;
        if (isLiveSession) {
          // Don't destroy a live session (even if detached) — the caller should attach instead
          this.log.warn(
            "Tab instance has live session, skipping duplicate create",
            {
              operation: "session_tab_duplicate_skip",
              existingSessionId: existing.id,
              tabInstanceId,
              hasAttachedWs:
                !!existing.ownerWs &&
                existing.ownerWs.readyState === WebSocket.OPEN,
            },
          );
          return existing.id;
        }
        this.log.warn("Tab instance already has session, destroying old", {
          operation: "session_tab_duplicate_cleanup",
          existingSessionId: existing.id,
          tabInstanceId,
        });
        this.destroySession(existing.id);
      }
    }

    const id = randomUUID();
    const now = Date.now();
    const session: TerminalSession = {
      id,
      userId,
      hostId,
      hostName,
      tabInstanceId,
      sshConn: null,
      sshStream: null,
      jumpClient: null,
      cols,
      rows,
      isConnected: false,
      createdAt: now,
      ownerWs: null,
      lastDetachedAt: null,
      detachTimeout: null,
      outputBuffer: [],
      outputBufferBytes: 0,
      tmuxSessionName: null,
    };
    this.sessions.set(id, session);

    this.log.info("Terminal session created", {
      operation: "session_created",
      sessionId: id,
      userId,
      hostId,
    });

    return id;
  }

  getSession(sessionId: string | null): TerminalSession | null {
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  setSSHState(
    sessionId: string,
    conn: Client,
    stream: ClientChannel,
    jumpClient?: Client | null,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.sshConn = conn;
    session.sshStream = stream;
    session.jumpClient = jumpClient ?? null;
    session.isConnected = true;
  }

  attachWs(
    sessionId: string,
    userId: string,
    ws: WebSocket,
    tabInstanceId?: string,
  ): TerminalSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.log.warn("Session not found for attachment", {
        operation: "session_attach_not_found",
        sessionId,
        userId,
      });
      return null;
    }
    if (session.userId !== userId) {
      this.log.warn("Session userId mismatch", {
        operation: "session_attach_user_mismatch",
        sessionId,
        expectedUserId: session.userId,
        providedUserId: userId,
      });
      return null;
    }
    if (!session.isConnected) {
      this.log.warn("Session not connected", {
        operation: "session_attach_not_connected",
        sessionId,
        userId,
        createdAt: session.createdAt,
        elapsed: Date.now() - session.createdAt,
      });
      return null;
    }

    const currentWs = session.ownerWs;
    const isDetached =
      !currentWs || currentWs.readyState !== WebSocket.OPEN;
    const isOriginalTab =
      (session.attachedTabInstanceId ?? session.tabInstanceId) ===
      tabInstanceId;

    if (
      !isDetached &&
      !isOriginalTab &&
      session.tabInstanceId &&
      tabInstanceId
    ) {
      this.log.warn("Session actively attached to different tab instance", {
        operation: "session_attach_instance_conflict",
        sessionId,
        sessionInstanceId: session.tabInstanceId,
        providedInstanceId: tabInstanceId,
      });
      try {
        ws.send(
          JSON.stringify({
            type: "sessionExpired",
            sessionId,
            message: "Session belongs to a different tab instance",
          }),
        );
      } catch {
        /* ignore */
      }
      return null;
    }

    if (
      session.tabInstanceId &&
      tabInstanceId &&
      session.tabInstanceId !== tabInstanceId
    ) {
      this.log.info(
        "Session attached to different tab instance (split-screen)",
        {
          operation: "session_attach_split_screen",
          originalInstanceId: session.tabInstanceId,
          newInstanceId: tabInstanceId,
          sessionId,
        },
      );
    }

    if (currentWs && currentWs !== ws && currentWs.readyState === WebSocket.OPEN) {
      try {
        currentWs.send(
          JSON.stringify({
            type: "sessionTakenOver",
            sessionId,
            message: "Session was attached from another tab",
          }),
        );
      } catch {
        /* ignore */
      }
    }

    if (session.detachTimeout) {
      clearTimeout(session.detachTimeout);
      session.detachTimeout = null;
    }

    session.ownerWs = ws;
    session.attachedTabInstanceId = tabInstanceId;
    session.lastDetachedAt = null;

    this.log.info("WebSocket attached to session", {
      operation: "session_attach",
      sessionId,
      userId,
      tabInstanceId,
    });

    return session;
  }

  /** Sends a message to the attached Owner socket, if present. */
  broadcast(sessionId: string, message: object): void {
    const session = this.sessions.get(sessionId);
    const ws = session?.ownerWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The health check or close handler will clean up the detached socket.
    }
  }

  detachWs(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.detachTimeout) {
      clearTimeout(session.detachTimeout);
      session.detachTimeout = null;
    }

    session.ownerWs = null;
    session.lastDetachedAt = Date.now();

    // Persist log immediately when the user detaches so it appears right away,
    // regardless of whether the session is later reattached or times out.
    this.maybePersistLog(session);

    const timeoutMs = this.getTimeoutMs();

    session.detachTimeout = setTimeout(() => {
      this.log.info("Session idle timeout expired", {
        operation: "session_idle_timeout",
        sessionId,
        userId: session.userId,
      });
      this.destroySession(sessionId);
    }, timeoutMs);

    this.log.info("WebSocket detached from session", {
      operation: "session_detach",
      sessionId,
      userId: session.userId,
      timeoutMinutes: timeoutMs / 60_000,
    });
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.detachTimeout) {
      clearTimeout(session.detachTimeout);
      session.detachTimeout = null;
    }

    session.ownerWs = null;

    if (session.sshStream) {
      try {
        session.sshStream.end();
      } catch {
        /* ignore */
      }
      session.sshStream = null;
    }

    if (session.sshConn) {
      try {
        session.sshConn.end();
      } catch {
        /* ignore */
      }
      session.sshConn = null;
    }

    if (session.jumpClient) {
      try {
        session.jumpClient.end();
      } catch {
        /* ignore */
      }
      session.jumpClient = null;
    }

    session.isConnected = false;
    session.outputBuffer = [];
    session.outputBufferBytes = 0;

    this.sessions.delete(sessionId);

    this.log.info("Terminal session destroyed", {
      operation: "session_destroyed",
      sessionId,
      userId: session.userId,
      hostId: session.hostId,
    });
  }

  getUserSessions(userId: string): TerminalSession[] {
    const result: TerminalSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        result.push(session);
      }
    }
    return result;
  }

  bufferOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.outputBuffer.push(data);
    session.outputBufferBytes += data.length;

    while (
      session.outputBufferBytes > MAX_BUFFER_BYTES &&
      session.outputBuffer.length > 0
    ) {
      const removed = session.outputBuffer.shift();
      if (removed) session.outputBufferBytes -= removed.length;
    }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cols = cols;
    session.rows = rows;
    this.broadcast(sessionId, { type: "resized", cols, rows });
  }

  flushBuffer(session: TerminalSession): string | null {
    if (session.outputBuffer.length === 0) return null;
    const data = session.outputBuffer.join("");
    session.outputBuffer = [];
    session.outputBufferBytes = 0;
    return data;
  }

  getBuffer(session: TerminalSession): string | null {
    if (session.outputBuffer.length === 0) return null;
    return session.outputBuffer.join("");
  }

  private getTimeoutMs(): number {
    const minutes = this.deps.getTimeoutMinutes();
    return (
      (Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_TIMEOUT_MINUTES) * 60_000
    );
  }

  private healthCheck(): void {
    const toDestroy: string[] = [];
    const now = Date.now();
    const GRACE_PERIOD_MS = 10_000;

    for (const [id, session] of this.sessions) {
      if (!session.isConnected) continue;

      if (session.ownerWs?.readyState === WebSocket.OPEN) {
        continue;
      }

      if (session.sshStream?.destroyed) {
        const detachedDuration = session.lastDetachedAt
          ? now - session.lastDetachedAt
          : 0;

        if (detachedDuration > GRACE_PERIOD_MS) {
          this.log.info(
            "SSH stream destroyed during detach window, cleaning up",
            {
              operation: "session_health_check_stream_destroyed",
              sessionId: id,
              userId: session.userId,
              detachedFor: detachedDuration,
            },
          );
          toDestroy.push(id);
        }
      }

      if (!session.sshConn) {
        toDestroy.push(id);
      }
    }

    for (const id of toDestroy) {
      this.destroySession(id);
    }
  }

  destroyAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.destroySession(id);
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
