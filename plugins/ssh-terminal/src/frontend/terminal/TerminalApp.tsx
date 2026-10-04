import React from "react";
import {
  useHosts,
  useTranslation,
  type PluginHostRecord,
} from "@termix/plugin-sdk/frontend";
import { ConnectionScreen } from "@termix/plugin-sdk/ui";
import { Terminal } from "./Terminal";
import type { TerminalHostConfig } from "./terminal-types";

interface TerminalAppProps {
  hostId?: string;
  /** tmux session to attach to once the shell is ready (tmux monitor "Attach"). */
  tmuxSession?: string;
}

function tmuxAttachCommand(session: string): string {
  return `tmux attach-session -t '=${session.replace(/'/g, "'\\''")}'`;
}

function toTerminalHost(host: PluginHostRecord): TerminalHostConfig {
  return {
    id: Number(host.id),
    instanceId: host.instanceId,
    name: host.name,
    ip: host.ip,
    port: host.sshPort ?? host.port ?? 22,
    username: host.username ?? "",
    authType: host.authType,
    credentialId:
      host.credentialId == null ? undefined : Number(host.credentialId),
    sshOptions: host.sshOptions,
    jumpHosts: host.jumpHosts,
    connectionType: host.connectionType,
    connectionOrigin: host.connectionOrigin,
    pluginSettings: host.pluginSettings,
  };
}

const TerminalApp: React.FC<TerminalAppProps> = ({ hostId, tmuxSession }) => {
  const { t } = useTranslation();
  const { hosts, loaded } = useHosts();
  const host = hostId
    ? hosts.find((candidate) => candidate.id === String(hostId))
    : undefined;

  if (!loaded) {
    return (
      <div className="relative h-full w-full">
        <ConnectionScreen
          status="connecting"
          message={t("hosts.loadingHost")}
        />
      </div>
    );
  }

  if (!host) {
    return (
      <div className="relative h-full w-full">
        <ConnectionScreen
          status="disconnected"
          message={t("hosts.hostNotFound")}
        />
      </div>
    );
  }

  const hostConfig = toTerminalHost(host);
  return (
    <Terminal
      hostConfig={hostConfig}
      isVisible={true}
      title={hostConfig.name || `${hostConfig.username}@${hostConfig.ip}`}
      showTitle={false}
      splitScreen={false}
      onClose={() => {}}
      executeCommand={
        tmuxSession ? tmuxAttachCommand(tmuxSession) : undefined
      }
    />
  );
};

export default TerminalApp;
