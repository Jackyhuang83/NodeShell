import type { ComponentType } from "react";
import { createRegistry } from "@/lib/registry";

/**
 * SSH auth editors render in the host and credential editors when their auth
 * type is selected. Browser login and second-factor UI are intentionally not
 * pluggable in NodeShell v0.1.
 */
export interface SshAuthEditorDef {
  /** The authType value stored on the host. */
  id: string;
  pluginId?: string;
  titleKey: string;
  hintKey?: string;
  component?: ComponentType<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form: any;
    setField: (key: string, value: unknown) => void;
  }>;
}

const sshAuthEditors = createRegistry<SshAuthEditorDef>();

export const registerSshAuthEditor = sshAuthEditors.register;
export const useSshAuthEditors = sshAuthEditors.useList;
