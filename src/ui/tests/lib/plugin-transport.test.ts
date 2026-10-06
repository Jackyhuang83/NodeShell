import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/main-axios", () => ({
  authApi: { defaults: { baseURL: "http://server:8080/" } },
}));
vi.mock("@/lib/device-id", () => ({ getDeviceId: () => "device-1" }));

import { pluginFetch } from "@/lib/plugin-transport";

const fetchMock = vi.fn(async () => new Response("ok"));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pluginFetch", () => {
  it("uses the Web backend with cookie auth and the NodeShell device header", async () => {
    await pluginFetch("ai", "chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://server:8080/plugin-api/ai/chat/stream");
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("POST");
    const headers = init.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-nodeshell-device-id")).toBe("device-1");
    expect(headers.get("authorization")).toBeNull();
  });
});
