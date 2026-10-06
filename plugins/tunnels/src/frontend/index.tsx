import type { ComponentType } from "react";
import { Network } from "lucide-react";
import type { TabProps, TermixApp } from "@termix/plugin-sdk/frontend";
import { TunnelTab } from "./TunnelTab";
import { HostTunnelsSection } from "./HostTunnelsSection";
import { setTunnelsApi } from "./api";
import { hostTunnelSettings } from "./host-tunnels";

function TunnelTabView({ host }: TabProps) {
  return <TunnelTab host={host} />;
}

export function activate(app: TermixApp): void {
  setTunnelsApi(app.api, {
    stream: (init) => app.fetch("/status/stream", init),
    remote: null,
  });
  app.onDispose(() => setTunnelsApi(null));

  app.registerTab("tunnel", TunnelTabView as ComponentType<TabProps>, {
    icon: Network,
    titleKey: "nav.tunnels",
    persistent: true,
    activityTypes: ["tunnel"],
  });

  app.registerHostAction({
    id: "tunnel",
    titleKey: "nav.tunnels",
    icon: Network,
    kind: "open",
    order: 40,
    tabType: "tunnel",
    copyUrlView: "tunnel",
    when: (host) =>
      host.enableSsh !== false && hostTunnelSettings(host).enabled,
  });

  app.registerHostEditorSection({
    id: "tunnels",
    group: "ssh",
    titleKey: "hosts.tabTunnels",
    icon: Network,
    order: 20,
    component: HostTunnelsSection,
  });
}
