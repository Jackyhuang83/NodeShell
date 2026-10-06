import { describe, expect, it } from "vitest";
import type { SSHHostWithStatus } from "@/main-axios";
import { sshHostToHost } from "@/sidebar/HostManagerData";

describe("sshHostToHost", () => {
  it("keeps every plugin's host settings so the editor can load them", () => {
    const pluginSettings = {
      docker: { enableDocker: true, containerRuntime: "podman" },
      "tmux-monitor": { enableTmuxMonitor: true },
    };
    const host = sshHostToHost({
      id: 3,
      name: "box",
      ip: "10.0.0.3",
      port: 22,
      username: "root",
      pluginSettings,
    } as unknown as SSHHostWithStatus);

    expect(host.pluginSettings).toEqual(pluginSettings);
  });

  it("defaults plugin settings to an empty map", () => {
    const host = sshHostToHost({
      id: 4,
      name: "bare",
      ip: "10.0.0.4",
      port: 22,
      username: "root",
    } as SSHHostWithStatus);

    expect(host.pluginSettings).toEqual({});
  });
});
