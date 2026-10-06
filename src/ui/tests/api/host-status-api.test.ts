import { beforeEach, describe, expect, it, vi } from "vitest";

const sshHostApiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/main-axios", () => ({
  sshHostApi: sshHostApiMock,
  handleApiError: vi.fn(),
}));

vi.mock("@/lib/hosts-request-cache", () => ({
  getCachedServerStatuses: (loader: () => Promise<unknown>) => loader(),
}));

import {
  getAllServerStatuses,
  getServerStatusById,
  refreshServerPolling,
  updateStatusCheckSettings,
} from "@/api/host-status-api";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("status checks", () => {
  it("reads every status from the NodeShell Web backend", async () => {
    sshHostApiMock.get.mockResolvedValueOnce({
      data: {
        1: { status: "online" },
        2: { status: "reachable" },
      },
    });

    await expect(getAllServerStatuses()).resolves.toEqual({
      1: { status: "online" },
      2: { status: "reachable" },
    });

    expect(sshHostApiMock.get).toHaveBeenCalledWith("/status", {
      timeout: 2000,
      __silentRetry: true,
    });
  });

  it("reads one host status directly", async () => {
    sshHostApiMock.get.mockResolvedValueOnce({
      data: { status: "online" },
    });

    await expect(getServerStatusById(7)).resolves.toEqual({
      status: "online",
    });
    expect(sshHostApiMock.get).toHaveBeenCalledWith("/status/7");
  });
});

describe("status check routes", () => {
  it("restarts checks through core", async () => {
    sshHostApiMock.post.mockResolvedValue({ data: {} });
    await refreshServerPolling();
    expect(sshHostApiMock.post).toHaveBeenCalledWith("/status/refresh");
  });

  it("saves the default interval", async () => {
    sshHostApiMock.put.mockResolvedValue({ data: {} });
    await updateStatusCheckSettings({ statusCheckInterval: 45 });
    expect(sshHostApiMock.put).toHaveBeenCalledWith("/status/settings", {
      statusCheckInterval: 45,
    });
  });
});
