import { randomUUID } from "crypto";
import { type Client, type ClientChannel } from "ssh2";
import { WebSocket } from "ws";
import type { TerminalLogger } from "./helpers.js";
import type { RecordingSink, RecordingsWriterV1 } from "./services.js";

const MAX_BUFFER_BYTES = 512 * 1024;
export const DEFAULT_TIMEOUT_MINUTES = 30;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const MAX_SESSIONS_PER_USER = 10;
// Coalesces recording writes: a chatty SSH stream can emit dozens of "data"
// events per second, and appending to disk on every single one saturates the
// libuv threadpool (default size 4), starving unrelated fs/DNS/crypto work
// and stalling the WS ping/pong health check enough to look like connection
// drops. Batch pending lines and flush on a short trailing edge instead.
const RECORDING_FLUSH_INTERVAL_MS = 300;

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
  /** Output listeners from the sessions.live service. */
  dataListeners: Set<(data: string) => void>;
  /** Resolves once the recordings service answered; null when off. */
  recordingSink: Promise<RecordingSink | null> | null;
  recordingHeader: string | null;
  recordingBytes: number;
  recordingWriteChain: Promise<void>;
  recordingPersistChain: Promise<void>;
  pendingRecordingData: string;
  recordingFlushTimer: NodeJS.Timeout | null;
  tmuxSessionName: string | null;
  sessionLoggingEnabled: boolean;
  sessionStartedAt: number;
  lastPersistedBytes: number;
  terminatedByOwner: boolean;
  terminationReason: string | null;
}

export interface SessionManagerDeps {
  log: TerminalLogger;
  /** Minutes a detached session is kept; read on every detach. */
  getTimeoutMinutes: () => number;
  /** The recordings.writer service, when a plugin provides it. */
  getRecordings: () => RecordingsWriterV1 | null;
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
    sessionLoggingEnabled = true,
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
    let recordingSink: Promise<RecordingSink | null> | null = null;
    let recordingHeader: string | null = null;
    const recordings = sessionLoggingEnabled ? this.deps.getRecordings() : null;
    if (recordings) {
      // Events recorded before this resolves wait in pendingRecordingData.
      recordingSink = Promise.resolve()
        .then(() =>
          recordings.open({
            sessionId: id,
            hostId,
            userId,
            protocol: "ssh",
            format: "asciicast",
            startedAt: now,
          }),
        )
        .catch((err) => {
          this.log.warn("Could not start a session recording", {
            operation: "session_recording_open_error",
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
    }
    if (recordingSink) {
      recordingHeader = `${JSON.stringify({
        version: 2,
        width: cols,
        height: rows,
        timestamp: Math.floor(now / 1000),
        env: { TERM: "xterm-256color", SHELL: "/bin/sh" },
      })}\n`;
    }
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
      dataListeners: new Set(),
      recordingSink,
      recordingHeader,
      recordingBytes: 0,
      recordingWriteChain: Promise.resolve(),
      recordingPersistChain: Promise.resolve(),
      pendingRecordingData: "",
      recordingFlushTimer: null,
      tmuxSessionName: null,
      sessionLoggingEnabled: !!recordingSink,
      sessionStartedAt: now,
      lastPersistedBytes: 0,
      terminatedByOwner: false,
      terminationReason: null,
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

    this.maybePersistLog(session, true);
    if (session.recordingSink && session.recordingBytes === 0) {
      void session.recordingSink.then((sink) => sink?.discard());
    }
    session.dataListeners.clear();

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

  private maybePersistLog(session: TerminalSession, force = false): void {
    if (!session.sessionLoggingEnabled) return;
    if (session.recordingFlushTimer) {
      clearTimeout(session.recordingFlushTimer);
      session.recordingFlushTimer = null;
      this.flushRecording(session);
    }
    if (session.recordingBytes === 0) return;
    if (!force && session.recordingBytes === session.lastPersistedBytes) return;
    session.lastPersistedBytes = session.recordingBytes;
    session.recordingPersistChain = session.recordingPersistChain
      .then(() => this.persistSessionLog(session))
      .catch((err) => {
        this.log.warn("Failed to persist session log", {
          operation: "session_log_persist_error",
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async persistSessionLog(session: TerminalSession): Promise<void> {
    if (!session.recordingSink) return;
    await session.recordingWriteChain;
    const sink = await session.recordingSink;
    if (!sink) return;
    const endedAt = Date.now();
    const duration = Math.floor((endedAt - session.sessionStartedAt) / 1000);

    try {
      await sink.persist({
        endedAt,
        durationSeconds: duration,
        terminatedByOwner: session.terminatedByOwner,
        terminationReason: session.terminationReason,
      });
    } catch (err) {
      this.log.warn("Failed to insert session recording row", {
        operation: "session_recording_insert_error",
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.log.info("Session log persisted", {
      operation: "session_log_persisted",
      sessionId: session.id,
      userId: session.userId,
      hostId: session.hostId,
      duration,
      bytes: session.recordingBytes,
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

    for (const listener of session.dataListeners) {
      try {
        listener(data);
      } catch {
        // A listener that throws must not break the session.
      }
    }

    this.recordSessionEvent(session, "o", data);
  }

  bufferInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.recordSessionEvent(session, "i", data);
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cols = cols;
    session.rows = rows;
    this.broadcast(sessionId, { type: "resized", cols, rows });
    this.bufferResize(sessionId, cols, rows);
  }

  bufferResize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.recordSessionEvent(session, "r", `${cols}x${rows}`);
  }

  private recordSessionEvent(
    session: TerminalSession,
    type: "i" | "o" | "r",
    data: string,
  ): void {
    if (!session.sessionLoggingEnabled || !session.recordingSink || !data)
      return;
    const elapsed = (Date.now() - session.sessionStartedAt) / 1000;
    const line = `${JSON.stringify([elapsed, type, data])}\n`;
    session.recordingBytes += Buffer.byteLength(line);
    session.pendingRecordingData += line;

    if (!session.recordingFlushTimer) {
      session.recordingFlushTimer = setTimeout(() => {
        session.recordingFlushTimer = null;
        this.flushRecording(session);
      }, RECORDING_FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Coalesces buffered recording lines into one write, chained so they land
   * in order. Never one write per chunk: that starved the libuv threadpool
   * (issue #1049).
   */
  private flushRecording(session: TerminalSession): void {
    const pendingSink = session.recordingSink;
    if (!pendingSink || !session.pendingRecordingData) return;
    const chunk = session.pendingRecordingData;
    session.pendingRecordingData = "";
    const firstWrite = session.recordingBytes === Buffer.byteLength(chunk);

    session.recordingWriteChain = session.recordingWriteChain
      .then(async () => {
        const sink = await pendingSink;
        if (!sink) return;
        await sink.append(
          firstWrite ? `${session.recordingHeader}${chunk}` : chunk,
        );
      })
      .catch((err) => {
        this.log.warn("Failed to write session recording", {
          operation: "session_recording_write_error",
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
