import { getErrorMessage } from "../utils/error-message.js";
import { parseSshOptions } from "./ssh-options.js";
import { findUsableCredential } from "./usable-credential.js";
import { resolveExternalSecretRefs } from "./external-secrets.js";
import { createCurrentHostResolutionRepository } from "../database/repositories/factory.js";
import { logger } from "../utils/logger.js";
import {
  pickResolvedPassword,
  pickResolvedUsername,
  expandExternalUsername,
} from "./credential-username.js";
import type { SSHHost } from "../../types/index.js";

const sshLogger = logger;

/**
 * Resolve a host with its credentials server-side by hostId.
 * This avoids passing credentials through the frontend.
 */
export async function resolveHostById(
  hostId: number,
  userId: string,
): Promise<SSHHost | null> {
  const repository = createCurrentHostResolutionRepository();
  const resolvedHost = await repository.findHostById(hostId, userId);
  if (!resolvedHost) return null;

  const host = resolvedHost as Record<string, unknown>;

  if (typeof host.jumpHosts === "string" && host.jumpHosts) {
    try {
      host.jumpHosts = JSON.parse(host.jumpHosts as string);
    } catch {
      host.jumpHosts = [];
    }
  }

  if (typeof host.terminalConfig === "string" && host.terminalConfig) {
    try {
      host.terminalConfig = JSON.parse(host.terminalConfig as string);
    } catch {
      host.terminalConfig = undefined;
    }
  }

  if (
    host.terminalConfig &&
    typeof host.terminalConfig === "object" &&
    !Array.isArray(host.terminalConfig)
  ) {
    const { sudoPassword: legacySudo, ...rest } = host.terminalConfig as Record<
      string,
      unknown
    >;
    if (!host.sudoPassword && legacySudo) {
      host.sudoPassword = legacySudo;
    }
    host.terminalConfig = rest;
  }

  host.sshOptions = parseSshOptions(
    host.sshOptions != null ? host.sshOptions : host.terminalConfig,
  );

  if (typeof host.portKnockSequence === "string" && host.portKnockSequence) {
    try {
      host.portKnockSequence = JSON.parse(host.portKnockSequence as string);
    } catch {
      host.portKnockSequence = [];
    }
  }

  let effectiveCredentialId = host.credentialId as number | null | undefined;
  if (!effectiveCredentialId && host.authType === "credential" && host.folder) {
    try {
      effectiveCredentialId = await repository.findFolderCredentialId(
        userId,
        host.folder as string,
      );
    } catch (error) {
      sshLogger.warn("Failed to resolve folder credential for host", {
        operation: "host_resolver_folder_credential",
        hostId,
        error: getErrorMessage(error, "Unknown"),
      });
    }
  }

  if (effectiveCredentialId) {
    try {
      const credential = (await findUsableCredential(
        effectiveCredentialId,
        userId,
      )) as Record<string, unknown> | null;

      if (credential) {
        host.password = pickResolvedPassword(host.password, credential.password);
        host.key = (credential.privateKey || credential.key) as string | null;
        host.keyPassword = credential.keyPassword;
        host.keyType = credential.keyType;
        host.certPublicKey = credential.certPublicKey || null;
        host.username = pickResolvedUsername(
          host.username,
          credential.username,
          host.overrideCredentialUsername,
        );
        host.authType = host.key
          ? "key"
          : host.password
            ? "password"
            : "none";
      }
    } catch (error) {
      sshLogger.warn("Failed to resolve credential for host", {
        operation: "host_resolver_credential",
        hostId,
        error: getErrorMessage(error, "Unknown"),
      });
    }
  }

  host.username = await expandExternalUsername(
    host.username as string | undefined,
    userId,
  );

  await resolveExternalSecretRefs(host, userId);

  try {
    const { loadHostPluginSettings } =
      await import("../database/routes/host-plugin-settings.js");
    const settings = (await loadHostPluginSettings([hostId])).get(hostId);
    if (settings) host.pluginSettings = settings;
  } catch (error) {
    sshLogger.warn("Failed to load plugin settings for host", {
      operation: "host_resolver_plugin_settings",
      hostId,
      error: getErrorMessage(error, "Unknown"),
    });
  }

  return host as unknown as SSHHost;
}
