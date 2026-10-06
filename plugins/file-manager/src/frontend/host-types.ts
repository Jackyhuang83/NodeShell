import type { HostSshOptions } from "@termix/plugin-sdk/frontend";

/** A host as the shell hands it to the file manager. */
export interface SSHHost {
  id: number;
  name: string;
  ip: string;
  port: number;
  username: string;
  folder: string;
  tags: string[];
  pin: boolean;
  authType: string;
  password?: string;
  key?: string;
  keyPassword?: string;
  keyType?: string;
  sudoPassword?: string;
  forceKeyboardInteractive?: boolean;
  credentialId?: number;
  overrideCredentialUsername?: boolean;
  userId?: string;
  jumpHosts?: Array<{ hostId: number }>;
  sshOptions?: HostSshOptions | null;
  notes?: string;
  connectionType?: string;
  enableSsh?: boolean;
  createdAt: string;
  updatedAt: string;
  instanceId?: string;
  /** Enabled plugins' host-scope settings, keyed by plugin id. */
  pluginSettings?: Record<string, Record<string, unknown>>;
}

export interface FileItem {
  name: string;
  path: string;
  isPinned?: boolean;
  type: "file" | "directory" | "link";
  sshSessionId?: string;
  size?: number;
  modified?: string;
  modifiedTimestamp?: number;
  permissions?: string;
  owner?: string;
  group?: string;
  linkTarget?: string;
  executable?: boolean;
}
