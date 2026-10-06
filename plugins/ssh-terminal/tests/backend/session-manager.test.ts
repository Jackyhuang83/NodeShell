import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "../../src/backend/session-manager.js";

const log = { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() };

function manager(timeoutMinutes = 30) {
  return new TerminalSessionManager({
    log,
    getTimeoutMinutes: () => timeoutMinutes,
  });
}

function makeFakeWs(readyState = 1 /* OPEN */) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  } as unknown as import("ws").WebSocket;
}

function connect(
  sessionManager: TerminalSessionManager,
  tabInstanceId = "tab-1",
): string {
  const id = sessionManager.createSession(
    "owner-1",
    1,
    "host",
    80,
    24,
    tabInstanceId,
  );
  sessionManager.setSSHState(
    id,
    { end: vi.fn() } as never,
    { destroyed: false, end: vi.fn(), write: vi.fn() } as never,
  );
  return id;
}

describe("TerminalSessionManager - owner sessions", () => {
  const managers: TerminalSessionManager[] = [];

  afterEach(() => {
    for (const item of managers.splice(0)) item.destroyAll();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("creates and lists only the owner's sessions", () => {
    const item = manager();
    managers.push(item);
    const id = item.createSession("owner-1", 1, "host", 80, 24);

    expect(item.getSession(id)?.userId).toBe("owner-1");
    expect(item.getUserSessions("owner-1").map((s) => s.id)).toEqual([id]);
    expect(item.getUserSessions("other")).toEqual([]);
  });

  it("attaches the Owner WebSocket and broadcasts only to it", () => {
    const item = manager();
    managers.push(item);
    const id = connect(item);
    const ws = makeFakeWs();

    expect(item.attachWs(id, "owner-1", ws, "tab-1")).not.toBeNull();
    item.broadcast(id, { type: "data", data: "hello" });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "data", data: "hello" }),
    );
  });

  it("rejects attaching a different account", () => {
    const item = manager();
    managers.push(item);
    const id = connect(item);

    expect(item.attachWs(id, "other", makeFakeWs(), "tab-1")).toBeNull();
  });

  it("takes over the previous Owner socket for the same tab", () => {
    const item = manager();
    managers.push(item);
    const id = connect(item);
    const first = makeFakeWs();
    const second = makeFakeWs();

    expect(item.attachWs(id, "owner-1", first, "tab-1")).not.toBeNull();
    expect(item.attachWs(id, "owner-1", second, "tab-1")).not.toBeNull();

    expect(first.send).toHaveBeenCalledWith(
      expect.stringContaining("sessionTakenOver"),
    );
    expect(item.getSession(id)?.ownerWs).toBe(second);
  });

  it("detaches without destroying the live SSH session", () => {
    vi.useFakeTimers();
    const item = manager(30);
    managers.push(item);
    const id = connect(item);
    item.attachWs(id, "owner-1", makeFakeWs(), "tab-1");

    item.detachWs(id);

    expect(item.getSession(id)?.ownerWs).toBeNull();
    expect(item.getSession(id)?.lastDetachedAt).not.toBeNull();
    expect(item.getSession(id)?.detachTimeout).not.toBeNull();
  });

  it("keeps a bounded replay buffer", () => {
    const item = manager();
    managers.push(item);
    const id = item.createSession("owner-1", 1, "host", 80, 24);
    const chunk = "x".repeat(300 * 1024);

    item.bufferOutput(id, chunk);
    item.bufferOutput(id, chunk);

    expect(item.getSession(id)!.outputBufferBytes).toBeLessThanOrEqual(
      512 * 1024,
    );
  });

  it("updates terminal dimensions and notifies the attached Owner", () => {
    const item = manager();
    managers.push(item);
    const id = connect(item);
    const ws = makeFakeWs();
    item.attachWs(id, "owner-1", ws, "tab-1");

    item.resizeSession(id, 120, 40);

    expect(item.getSession(id)).toMatchObject({ cols: 120, rows: 40 });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "resized", cols: 120, rows: 40 }),
    );
  });
});
