/**
 * The services this plugin provides and consumes.
 *
 * Optional service contracts used by SSH Terminal. Tmux integration and
 * recording are isolated so the terminal itself remains usable without them.
 */

export interface CommandHistoryEntry {
  command: string;
  executedAt: string;
}

export interface TerminalHistoryV1 {
  /** The acting user's most recent commands on one host, newest first. */
  list: (hostId: number, limit?: number) => Promise<CommandHistoryEntry[]>;
}

export interface TmuxDetection {
  available: boolean;
  sessions: string[];
}

/**
 * What the terminal asks of the tmux plugin. Clients are ssh2 objects. Every
 * method is async to a consumer: a service call goes through the permission
 * check and the audit line first.
 */
export interface TmuxSessionsV1 {
  detect: (client: unknown) => Promise<TmuxDetection>;
  /** Writes the attach (or new-session) command into a shell stream. */
  attachOrCreate: (
    stream: unknown,
    name?: string,
    newName?: string,
    hostId?: number,
  ) => Promise<void>;
  /** Waits for a new session to exist and returns its confirmed name. */
  waitForSession: (client: unknown, name: string) => Promise<string>;
}

export interface RecordingSink {
  /** Appends one batch; the first batch starts with the asciicast header. */
  append: (chunk: string) => Promise<void>;
  /** Writes or updates the recording row. */
  persist: (summary: {
    endedAt: number;
    durationSeconds: number;
    terminatedByOwner: boolean;
    terminationReason: string | null;
  }) => Promise<void>;
  /** Nothing was recorded; drop whatever was set up. */
  discard: () => void;
}

export interface RecordingsWriterV1 {
  /** Null when recording is off for this user or host. */
  open: (meta: {
    sessionId: string;
    hostId: number;
    userId: string;
    protocol: "ssh";
    format: "asciicast";
    startedAt: number;
  }) => Promise<RecordingSink | null>;
}
