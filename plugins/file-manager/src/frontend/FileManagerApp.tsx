import React from "react";
import {
  useHosts,
  useTranslation,
  type PluginHostRecord,
} from "@termix/plugin-sdk/frontend";
import { ConnectionScreen } from "@termix/plugin-sdk/ui";
import { FileManager } from "./FileManager.tsx";
import type { SSHHost } from "./host-types";

interface FileManagerAppProps {
  hostId?: string;
  initialPath?: string;
}

function toSshHost(host: PluginHostRecord): SSHHost {
  return {
    id: Number(host.id),
    name: host.name,
    ip: host.ip,
    port: host.sshPort ?? host.port ?? 22,
    username: host.username ?? "",
    folder: host.folder ?? "",
    tags: host.tags ?? [],
    pin: !!host.pin,
    authType: host.authType ?? "password",
    credentialId:
      host.credentialId == null ? undefined : Number(host.credentialId),
    overrideCredentialUsername: host.overrideCredentialUsername,
    jumpHosts: host.jumpHosts?.map((jump) => ({
      hostId: Number(jump.hostId),
    })),
    sshOptions: host.sshOptions,
    notes: host.notes,
    connectionType: host.connectionType,
    enableSsh: host.enableSsh,
    syncId: host.syncId,
    createdAt: "",
    updatedAt: "",
    connectionOrigin: host.connectionOrigin,
    instanceId: host.instanceId,
    isShared: host.isShared,
    permissionLevel: host.permissionLevel,
    pluginSettings: host.pluginSettings,
  };
}

const FileManagerApp: React.FC<FileManagerAppProps> = ({
  hostId,
  initialPath,
}) => {
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

  return (
    <FileManager
      initialHost={toSshHost(host)}
      initialPath={initialPath}
      onClose={() => {}}
    />
  );
};

export default FileManagerApp;
