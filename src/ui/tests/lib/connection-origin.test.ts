import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOriginWsUrl,
  resolveConnectionOrigin,
} from "../../lib/connection-origin.js";
import { websocketAuthProtocols } from "@/lib/ws-auth";

describe("resolveConnectionOrigin", () => {
  it("always uses the NodeShell Web backend", async () => {
    await expect(
      resolveConnectionOrigin({ connectionOrigin: null }),
    ).resolves.toBe("local");
    await expect(
      resolveConnectionOrigin(
        { connectionOrigin: "remote" },
        { defaultRemote: true },
      ),
    ).resolves.toBe("local");
  });
});

describe("buildOriginWsUrl", () => {
  const store: Record<string, string> = {};

  beforeEach(() => {
    store.jwt = "web-jwt";
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("targets the current WebUI origin and carries websocket auth", async () => {
    const target = await buildOriginWsUrl({
      origin: "local",
      localPort: 30001,
      localPath: "/plugin-ws/ssh-terminal/terminal",
      remotePath: "/plugin-ws/ssh-terminal/terminal",
    });
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    expect(target.url).toContain(`${scheme}://${window.location.host}`);
    expect(target.url).toContain("/plugin-ws/ssh-terminal/terminal");
    expect(target.protocols).toEqual(websocketAuthProtocols("web-jwt"));
  });

  it("can omit websocket auth explicitly", async () => {
    const target = await buildOriginWsUrl({
      origin: "local",
      localPort: 30001,
      localPath: "/plugin-ws/ssh-terminal/terminal",
      remotePath: "/plugin-ws/ssh-terminal/terminal",
      includeJwt: false,
    });
    expect(target.protocols).toEqual([]);
  });
});
