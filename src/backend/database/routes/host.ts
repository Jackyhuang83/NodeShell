import { getErrorMessage } from "../../utils/error-message.js";
import { findUsableCredential } from "../../hosts/usable-credential.js";
import type { AuthenticatedRequest } from "../../../types/index.js";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { sshLogger, databaseLogger } from "../../utils/logger.js";
import { pluginEvents, TOPICS } from "../../plugins/events.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { PermissionManager } from "../../utils/permission-manager.js";
import { parseSSHKey } from "../../utils/ssh-key-utils.js";
import {
  pickResolvedPassword,
  pickResolvedUsername,
} from "../../hosts/credential-username.js";
import { emitInternalEvent } from "../../hosts/internal-events.js";
import { deleteOwnedHost } from "../../hosts/delete-host.js";
import {
  createCurrentCredentialRepository,
  createCurrentHostResolutionRepository,
  createCurrentHostRepository,
  createCurrentHostDefaultsRepository,
} from "../repositories/factory.js";
import {
  applyHostKeyTypeUpdate,
  isNonEmptyString,
  isOptionalBoolean,
  isValidPort,
  normalizeProtocolEnableFields,
  hostTerminalExport,
  stripSensitiveFields,
  transformHostResponse,
} from "./host-normalizers.js";
import {
  attachHostPluginSettings,
  loadHostPluginSettings,
  withHostPluginSettings,
} from "./host-plugin-settings.js";
import { validateParentHostId } from "./host-parent-validation.js";
import { registerHostFolderRoutes } from "./host-folder-routes.js";
import { registerHostBulkRoutes } from "./host-bulk-routes.js";
import { registerHostDefaultsRoutes } from "./host-defaults-routes.js";
import { registerHostStatusRoutes } from "./host-status-routes.js";
import {
  applyHostEnrollmentDefaults,
  requireHostEnrollmentAccessForPath,
} from "./host-enrollment-auth.js";
import {
  logAudit,
  getAuditUsername,
  getRequestMeta,
} from "../../utils/audit-logger.js";
import type {
  HostResolutionCredentialRecord,
} from "../repositories/host-resolution-repository.js";
import { sshOptionsForWrite } from "../../hosts/ssh-options.js";
import {
  applyDefaultsAfterHostWrite,
  applyHostDefaultsToWrite,
} from "../../hosts/defaults/index.js";
import { applyPersonalHostValues } from "../../hosts/defaults/personal.js";
import {
  applyProtocolAuthPlan,
  attachProtocolAuth,
  firstProtocolUsername,
  listProtocolLogins,
  loadProtocolAuthSummaries,
  planProtocolAuthWrite,
  ProtocolAuthWriteError,
  readProtocolAuthPayload,
  toPortableLogins,
  withProtocolAuth,
  writeProtocolAuth,
  type PlannedProtocolAuth,
} from "../../hosts/protocol-auth/protocol-auth.js";
import { findHostProtocol } from "../../hosts/protocol-auth/registry.js";
import { mergeStoredTerminalFields } from "./host-terminal-fields.js";

const router = express.Router();
router.use((req, res, next) => {
  const blocked = req.method === "GET" && (/^\/db\/host\/\d+\/password$/.test(req.path) || /^\/db\/host\/\d+\/export$/.test(req.path) || req.path === "/db/hosts/export");
  if (blocked) return res.status(404).json({ error: "Not found" });
  next();
});

const upload = multer({ storage: multer.memoryStorage() });

/**
 * Tells whoever is polling this host that its details changed.
 *
 * An event, so whichever plugin polls the host can listen for it. Fire and
 * forget, so a subscriber that throws cannot fail the host update that
 * caused it.
 */
function notifyStatsHostUpdated(
  hostId: number,
  userId: string,
  operation: string,
): void {
  try {
    // The user travels with the event: a subscriber re-reading the host needs
    // a data key, and the bus carries no session of its own.
    pluginEvents.emit(TOPICS.hostUpdated, { hostId, userId });
  } catch (err) {
    sshLogger.warn("Failed to publish host update event", {
      operation,
      hostId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const authManager = AuthManager.getInstance();
const permissionManager = PermissionManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();
const requireDataAccess = authManager.createDataAccessMiddleware();

registerHostStatusRoutes(router, {
  authenticateJWT,
  requireAdmin: authManager.createAdminMiddleware(),
});

/**
 * @openapi
 * /host/db/host:
 *   post:
 *     summary: Create SSH host
 *     description: Creates a new SSH host configuration.
 *     tags:
 *       - SSH
 *     responses:
 *       200:
 *         description: Host created successfully.
 *       400:
 *         description: Invalid SSH data.
 *       500:
 *         description: Failed to save SSH data.
 */
router.post(
  ["/db/host", "/enroll"],
  authenticateJWT,
  permissionManager.requirePermission("hosts.create"),
  requireDataAccess,
  requireHostEnrollmentAccessForPath,
  upload.single("key"),
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    let hostData: Record<string, unknown>;

    if (req.headers["content-type"]?.includes("multipart/form-data")) {
      if (req.body.data) {
        try {
          hostData = JSON.parse(req.body.data);
        } catch (err) {
          sshLogger.warn("Invalid JSON data in multipart request", {
            operation: "host_create",
            userId,
            error: err,
          });
          return res.status(400).json({ error: "Invalid JSON data" });
        }
      } else {
        sshLogger.warn("Missing data field in multipart request", {
          operation: "host_create",
          userId,
        });
        return res.status(400).json({ error: "Missing data field" });
      }

      if (req.file) {
        hostData.key = req.file.buffer.toString("utf8");
      }
    } else {
      hostData = req.body;
    }

    if (req.path === "/enroll") {
      hostData = applyHostEnrollmentDefaults(hostData);
    }

    const {
      connectionType,
      name,
      folder,
      parentHostId,
      tags,
      ip,
      port,
      username,
      password,
      authMethod,
      authType,
      credentialId,
      key,
      keyPassword,
      keyType,
      sudoPassword,
      pin,
      jumpHosts,
      statusCheckEnabled,
      statusCheckInterval,
      terminalConfig,
      sshOptions,
      forceKeyboardInteractive,
      notes,
      connectionOrigin,
      localOnly,
      portKnockSequence,
      overrideCredentialUsername,
      enableSsh,
      sshPort,
    } = hostData;
    const protocolAuthPatch = readProtocolAuthPayload(hostData);
    databaseLogger.info("Creating SSH host", {
      operation: "host_create",
      userId,
      name,
      ip,
    });

    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(ip) ||
      !isValidPort(port) ||
      !isOptionalBoolean(enableSsh)
    ) {
      sshLogger.warn("Invalid SSH data input validation failed", {
        operation: "host_create",
        userId,
        hasIp: !!ip,
        port,
        isValidPort: isValidPort(port),
      });
      return res.status(400).json({ error: "Invalid SSH data" });
    }

    let validatedParentHostId: number | null = null;
    if (parentHostId !== undefined && parentHostId !== null) {
      const numericParentHostId = Number(parentHostId);
      if (!Number.isInteger(numericParentHostId)) {
        return res.status(400).json({ error: "Invalid parent host" });
      }
      const parentError = await validateParentHostId(
        userId,
        null,
        numericParentHostId,
      );
      if (parentError) {
        return res.status(400).json({ error: parentError });
      }
      validatedParentHostId = numericParentHostId;
    }

    const effectiveConnectionType = connectionType || "ssh";
    const effectiveAuthType =
      authType ||
      authMethod ||
      (effectiveConnectionType !== "ssh" ? "password" : undefined);
    const effectiveUsername =
      username || firstProtocolUsername(protocolAuthPatch);
    const effectiveName =
      name || (effectiveUsername ? `${effectiveUsername}@${ip}` : String(ip));
    const sshDataObj: Record<string, unknown> = {
      userId: userId,
      connectionType: effectiveConnectionType,
      name: effectiveName,
      // A host is either placed in a folder or nested under a parent host,
      // never both -- setting one clears the other.
      folder: validatedParentHostId ? null : folder || null,
      parentHostId: validatedParentHostId,
      tags: Array.isArray(tags) ? tags.join(",") : tags || "",
      ip,
      port,
      username: effectiveUsername,
      authType: effectiveAuthType,
      credentialId: credentialId || null,
      overrideCredentialUsername: overrideCredentialUsername ? 1 : 0,
      pin: pin ? 1 : 0,
      jumpHosts: Array.isArray(jumpHosts) ? JSON.stringify(jumpHosts) : null,
      statusCheckEnabled: statusCheckEnabled === false ? 0 : 1,
      statusCheckInterval: normalizeStatusInterval(statusCheckInterval),
      terminalConfig: terminalConfig
        ? typeof terminalConfig === "string"
          ? terminalConfig
          : JSON.stringify(terminalConfig)
        : null,
      sshOptions: sshOptionsForWrite({ sshOptions, terminalConfig }) ?? null,
      forceKeyboardInteractive: forceKeyboardInteractive ? "true" : "false",
      notes: notes || null,
      sudoPassword: sudoPassword || null,
      connectionOrigin:
        connectionOrigin === "local" || connectionOrigin === "remote"
          ? connectionOrigin
          : null,
      ...(typeof localOnly === "boolean" ? { localOnly } : {}),
      portKnockSequence: portKnockSequence
        ? JSON.stringify(portKnockSequence)
        : null,
      ...normalizeProtocolEnableFields(hostData),
      sshPort: sshPort || port || 22,
    };

    // A host whose main protocol is a plugin's keeps any password it is given.
    if (effectiveConnectionType !== "ssh") {
      sshDataObj.password = password || null;
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    } else if (effectiveAuthType === "password") {
      sshDataObj.password = password || null;
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    } else if (effectiveAuthType === "key") {
      if (key && typeof key === "string") {
        const keyValidation = parseSSHKey(
          key,
          typeof keyPassword === "string" ? keyPassword : undefined,
        );
        if (!keyValidation.success) {
          sshLogger.warn("SSH key validation failed", {
            operation: "host_create",
            userId,
            name,
            ip,
            port,
            error: keyValidation.error,
          });
          return res.status(400).json({
            error: `Invalid SSH key: ${keyValidation.error || "Unable to parse key"}`,
          });
        }
      }

      sshDataObj.key = key || null;
      sshDataObj.keyPassword = keyPassword || null;
      sshDataObj.keyType = keyType;
      sshDataObj.password = password || null;
    } else if (effectiveAuthType === "credential") {
      sshDataObj.password = password || null;
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    } else if (effectiveAuthType === "agent") {
      sshDataObj.password = null;
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    } else {
      sshDataObj.password = null;
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    }

    try {
      sshDataObj.defaultOverrides = JSON.stringify(
        await applyHostDefaultsToWrite({
          ownerId: userId,
          hostId: null,
          columns: sshDataObj,
          body: hostData,
        }),
      );
      const result = await createCurrentHostRepository().createEncryptedForUser(
        userId,
        sshDataObj,
      );

      if (!result) {
        sshLogger.warn("No host returned after creation", {
          operation: "host_create",
          userId,
          name,
          ip,
          port,
        });
        return res.status(500).json({ error: "Failed to create host" });
      }

      const createdHost = result;
      await applyDefaultsAfterHostWrite(createdHost.id as number);
      if (protocolAuthPatch) {
        await writeProtocolAuth(
          userId,
          createdHost.id as number,
          protocolAuthPatch,
          { isOwner: true },
        );
      }

      const baseHost = transformHostResponse(createdHost);      const baseHost = transformHostResponse(createdHost);

      const resolvedHost =
        (await resolveHostCredentials(baseHost, userId)) || baseHost;
      databaseLogger.success("SSH host created", {
        operation: "host_create_success",
        userId,
        hostId: createdHost.id as number,
        name,
      });

      const { ipAddress: chIp, userAgent: chUa } = getRequestMeta(req);
      await logAudit({
        userId,
        username: await getAuditUsername(userId),
        action: "create_host",
        resourceType: "host",
        resourceId: String(createdHost.id),
        resourceName: String(name ?? ip),
        ipAddress: chIp,
        userAgent: chUa,
        success: true,
      });

      emitInternalEvent("host_added", userId, createdHost.id as number, {
        name: String(name ?? ip),
      });

      res.json(await withProtocolAuth(stripSensitiveFields(resolvedHost)));
      notifyStatsHostUpdated(createdHost.id as number, userId, "host_create");
    } catch (err) {
      sshLogger.error("Failed to save SSH host to database", err, {
        operation: "host_create",
        userId,
        name,
        ip,
        port,
        authType: effectiveAuthType,
      });
      res.status(500).json({ error: "Failed to save SSH data" });
    }
  },
);

/**
 * @openapi
 * /host/enroll:
 *   post:
 *     summary: Enroll a host with an API key
 *     description: Creates a host owned by the user assigned to the API key. The user's encrypted data must be unlocked by an active sign-in.
 *     tags:
 *       - Host Enrollment
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ip]
 *             properties:
 *               name:
 *                 type: string
 *               ip:
 *                 type: string
 *               port:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 65535
 *                 default: 22
 *               username:
 *                 type: string
 *               authType:
 *                 type: string
 *                 enum: [none, password, key, credential, agent]
 *                 default: none
 *               password:
 *                 type: string
 *               folder:
 *                 type: string
 *               tags:
 *                 oneOf:
 *                   - type: string
 *                   - type: array
 *                     items:
 *                       type: string
 *     responses:
 *       200:
 *         description: Host enrolled successfully.
 *       400:
 *         description: Invalid host data.
 *       401:
 *         description: Missing or invalid API key.
 *       423:
 *         description: The API key user's encrypted data is locked.
 *       500:
 *         description: Failed to enroll the host.
 */
/**
 * @openapi
 * /host/db/host/{id}:
 *   put:
 *     summary: Update SSH host
 *     description: Updates an existing SSH host configuration.
 *     tags:
 *       - SSH
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Host updated successfully.
 *       400:
 *         description: Invalid SSH data.
 *       403:
 *         description: Access denied.
 *       404:
 *         description: Host not found.
 *       500:
 *         description: Failed to update SSH data.
 */
router.put(
  "/db/host/:id",
  authenticateJWT,
  permissionManager.requirePermission("hosts.edit"),
  requireDataAccess,
  upload.single("key"),
  async (req: Request, res: Response) => {
    const hostId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;
    const userId = (req as AuthenticatedRequest).userId;
    let hostData: Record<string, unknown>;

    if (req.headers["content-type"]?.includes("multipart/form-data")) {
      if (req.body.data) {
        try {
          hostData = JSON.parse(req.body.data);
        } catch (err) {
          sshLogger.warn("Invalid JSON data in multipart request", {
            operation: "host_update",
            hostId: parseInt(hostId),
            userId,
            error: err,
          });
          return res.status(400).json({ error: "Invalid JSON data" });
        }
      } else {
        sshLogger.warn("Missing data field in multipart request", {
          operation: "host_update",
          hostId: parseInt(hostId),
          userId,
        });
        return res.status(400).json({ error: "Missing data field" });
      }

      if (req.file) {
        hostData.key = req.file.buffer.toString("utf8");
      }
    } else {
      hostData = req.body;
    }

    const {
      connectionType,
      name,
      folder,
      parentHostId,
      tags,
      ip,
      port,
      username,
      password,
      authMethod,
      authType,
      credentialId,
      key,
      keyPassword,
      keyType,
      sudoPassword,
      pin,
      jumpHosts,
      statusCheckEnabled,
      statusCheckInterval,
      terminalConfig,
      sshOptions,
      forceKeyboardInteractive,
      notes,
      connectionOrigin,
      localOnly,
      portKnockSequence,
      overrideCredentialUsername,
      enableSsh,
      sshPort,
    } = hostData;
    const protocolAuthPatch = readProtocolAuthPayload(hostData);
    databaseLogger.info("Updating SSH host", {
      operation: "host_update",
      userId,
      hostId: parseInt(hostId),
      changes: Object.keys(hostData),
    });

    if (
      !isNonEmptyString(userId) ||
      !isNonEmptyString(ip) ||
      !isValidPort(port) ||
      !isOptionalBoolean(enableSsh) ||
      !hostId
    ) {
      sshLogger.warn("Invalid SSH data input validation failed for update", {
        operation: "host_update",
        hostId: parseInt(hostId),
        userId,
        hasIp: !!ip,
        port,
        isValidPort: isValidPort(port),
      });
      return res.status(400).json({ error: "Invalid SSH data" });
    }

    let validatedParentHostId: number | null | undefined = undefined;
    if (parentHostId !== undefined) {
      if (parentHostId === null) {
        validatedParentHostId = null;
      } else {
        const numericParentHostId = Number(parentHostId);
        if (!Number.isInteger(numericParentHostId)) {
          return res.status(400).json({ error: "Invalid parent host" });
        }
        const parentError = await validateParentHostId(
          userId,
          Number(hostId),
          numericParentHostId,
        );
        if (parentError) {
          return res.status(400).json({ error: parentError });
        }
        validatedParentHostId = numericParentHostId;
      }
    }

    const effectiveAuthType = authType || authMethod;
    const effectiveUsername =
      username || firstProtocolUsername(protocolAuthPatch);
    const effectiveName =
      name || (effectiveUsername ? `${effectiveUsername}@${ip}` : String(ip));
    const sshDataObj: Record<string, unknown> = {
      connectionType: connectionType || "ssh",
      name: effectiveName,
      // A host is either placed in a folder or nested under a parent host,
      // never both. When the caller is assigning a parent, clear folder;
      // when the caller is assigning a folder, clear parentHostId.
      folder: validatedParentHostId ? null : folder,
      tags: Array.isArray(tags) ? tags.join(",") : tags || "",
      ip,
      port,
      username: effectiveUsername,
      authType: effectiveAuthType,
      credentialId: credentialId || null,
      overrideCredentialUsername: overrideCredentialUsername ? 1 : 0,
      pin: pin ? 1 : 0,
      jumpHosts: Array.isArray(jumpHosts) ? JSON.stringify(jumpHosts) : null,
      statusCheckEnabled: statusCheckEnabled === false ? 0 : 1,
      statusCheckInterval: normalizeStatusInterval(statusCheckInterval),
      terminalConfig: terminalConfig
        ? typeof terminalConfig === "string"
          ? terminalConfig
          : JSON.stringify(terminalConfig)
        : null,
      forceKeyboardInteractive: forceKeyboardInteractive ? "true" : "false",
      notes: notes || null,
      connectionOrigin:
        connectionOrigin === "local" || connectionOrigin === "remote"
          ? connectionOrigin
          : null,
      ...(typeof localOnly === "boolean" ? { localOnly } : {}),
      portKnockSequence: portKnockSequence
        ? JSON.stringify(portKnockSequence)
        : null,
      ...normalizeProtocolEnableFields(hostData),
      sshPort: sshPort || port || 22,
    };

    const nextSshOptions = sshOptionsForWrite({ sshOptions, terminalConfig });
    if (nextSshOptions !== undefined) sshDataObj.sshOptions = nextSshOptions;
    // The editor leaves sudoPassword out when the user did not touch it.
    if (sudoPassword !== undefined) {
      sshDataObj.sudoPassword = sudoPassword || null;
    }

    // A host whose main protocol is a plugin's keeps any password it is given.
    if ((connectionType || "ssh") !== "ssh") {
      if (password) {
        sshDataObj.password = password;
      }
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    } else if (effectiveAuthType === "password") {
      if (password) {
        sshDataObj.password = password;
      }
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    } else if (effectiveAuthType === "key") {
      if (key && typeof key === "string") {
        const keyValidation = parseSSHKey(
          key,
          typeof keyPassword === "string" ? keyPassword : undefined,
        );
        if (!keyValidation.success) {
          sshLogger.warn("SSH key validation failed", {
            operation: "host_update",
            hostId: parseInt(hostId),
            userId,
            name,
            ip,
            port,
            error: keyValidation.error,
          });
          return res.status(400).json({
            error: `Invalid SSH key: ${keyValidation.error || "Unable to parse key"}`,
          });
        }

        sshDataObj.key = key;
      }
      if (keyPassword !== undefined) {
        sshDataObj.keyPassword = keyPassword || null;
      }
      applyHostKeyTypeUpdate(sshDataObj, keyType);
      sshDataObj.password = password || null;
    } else if (effectiveAuthType === "credential") {
      sshDataObj.password = password || null;
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    } else if (effectiveAuthType === "agent") {
      sshDataObj.password = null;
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    } else {
      sshDataObj.password = null;
      sshDataObj.key = null;
      sshDataObj.keyPassword = null;
      sshDataObj.keyType = null;
    }

    if (validatedParentHostId !== undefined) {
      sshDataObj.parentHostId = validatedParentHostId;
    } else if (folder !== undefined) {
      // Caller is assigning a folder (including clearing it back to root)
      // without touching parentHostId -- folder placement replaces
      // parent-host placement either way.
      sshDataObj.parentHostId = null;
    }

    try {
      const accessInfo = await permissionManager.canAccessHost(
        userId,
        Number(hostId),
        "edit",
      );

      if (!accessInfo.hasAccess) {
        sshLogger.warn("User does not have permission to update host", {
          operation: "host_update",
          hostId: parseInt(hostId),
          userId,
        });
        return res.status(403).json({ error: "Access denied" });
      }

      const hostRecord =
        await createCurrentHostResolutionRepository().findHostUpdateState(
          Number(hostId),
        );

      if (!hostRecord) {
        sshLogger.warn("Host not found for update", {
          operation: "host_update",
          hostId: parseInt(hostId),
          userId,
        });
        return res.status(404).json({ error: "Host not found" });
      }

      const ownerId = hostRecord.userId;

      let protocolAuthPlan: PlannedProtocolAuth | null = null;      let protocolAuthPlan: PlannedProtocolAuth | null = null;
      if (protocolAuthPatch) {
        try {
          protocolAuthPlan = await planProtocolAuthWrite(
            ownerId,
            Number(hostId),
            protocolAuthPatch,
            { isOwner: true },
          );
        } catch (error) {
          if (error instanceof ProtocolAuthWriteError) {
            return res.status(error.status).json({ error: error.message });
          }
          throw error;
        }
      }

      const terminalFieldsError = await mergeStoredTerminalFields(
        sshDataObj,
        hostData,
        Number(hostId),
        ownerId,
        true,
      );
      if (terminalFieldsError) {
        return res.status(400).json({ error: terminalFieldsError });
      }

      const storedRow = (
        await createCurrentHostDefaultsRepository().listHosts({
          hostIds: [Number(hostId)],
        })
      )[0];
      sshDataObj.defaultOverrides = JSON.stringify(
        await applyHostDefaultsToWrite({
          ownerId,
          hostId: Number(hostId),
          columns: sshDataObj,
          body: hostData,
          stored: storedRow,
          lockedKeys: [],
        }),
      );

      await createCurrentHostRepository().updateEncryptedForUser(
        ownerId,
        Number(hostId),
        sshDataObj,
      );
      await applyDefaultsAfterHostWrite(Number(hostId), {
        moved:
          !!storedRow &&
          ((sshDataObj.folder !== undefined &&
            (sshDataObj.folder ?? null) !== (storedRow.folder ?? null)) ||
            (sshDataObj.parentHostId !== undefined &&
              (sshDataObj.parentHostId ?? null) !==
                (storedRow.parentHostId ?? null))),
        ownerId,
      });
      if (protocolAuthPlan) {
        await applyProtocolAuthPlan(ownerId, Number(hostId), protocolAuthPlan);
      }

      const updatedHost =      const updatedHost =
        await createCurrentHostResolutionRepository().findHostById(
          Number(hostId),
          ownerId,
        );

      if (!updatedHost) {
        sshLogger.warn("Updated host not found after update", {
          operation: "host_update",
          hostId: parseInt(hostId),
          userId,
        });
        return res.status(404).json({ error: "Host not found after update" });
      }

      const baseHost = transformHostResponse(updatedHost);

      const resolvedHost =
        (await resolveHostCredentials(baseHost, userId)) || baseHost;
      databaseLogger.success("SSH host updated", {
        operation: "host_update_success",
        userId,
        hostId: parseInt(hostId),
      });

      const { ipAddress: uhIp, userAgent: uhUa } = getRequestMeta(req);
      await logAudit({
        userId,
        username: await getAuditUsername(userId),
        action: "update_host",
        resourceType: "host",
        resourceId: hostId,
        resourceName: String(name ?? ip),
        ipAddress: uhIp,
        userAgent: uhUa,
        success: true,
      });

      res.json(await withProtocolAuth(stripSensitiveFields(resolvedHost)));
      notifyStatsHostUpdated(parseInt(hostId), userId, "host_update");
    } catch (err) {
      sshLogger.error("Failed to update SSH host in database", err, {
        operation: "host_update",
        hostId: parseInt(hostId),
        userId,
        name,
        ip,
        port,
        authType: effectiveAuthType,
      });
      res.status(500).json({ error: "Failed to update SSH data" });
    }
  },
);

/**
 * @openapi
 * /host/db/host:
 *   get:
 *     summary: Get all SSH hosts
 *     description: Retrieves all SSH hosts owned by the authenticated Owner.
 *     tags:
 *       - SSH
 */
router.get(
  "/db/host",
  authenticateJWT,
  permissionManager.requirePermission("hosts.view"),
  requireDataAccess,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!isNonEmptyString(userId)) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    try {
      const hosts =
        await createCurrentHostResolutionRepository().findHostsByUserId(userId);

      const credentialIds = hosts
        .map((host) => host.credentialId)
        .filter((id): id is number => typeof id === "number");
      const credentialsById = await createCurrentHostResolutionRepository()
        .listCredentialsByIdsForUser(credentialIds, userId)
        .catch(() => new Map<number, HostResolutionCredentialRecord>());

      const result = await Promise.all(
        hosts.map(async (host) => {
          const transformed = transformHostResponse(host);
          return (
            (await resolveHostCredentials(
              transformed,
              userId,
              credentialsById,
            )) || transformed
          );
        }),
      );

      attachProtocolAuth(result, await loadProtocolAuthSummaries(result));
      const sanitized = result.map((host) => stripSensitiveFields(host));

      const pluginSettingsByHost = await loadHostPluginSettings(
        sanitized
          .map((host) => Number(host.id))
          .filter((id) => Number.isInteger(id)),
      );
      await applyPersonalHostValues(pluginSettingsByHost, userId).catch(
        () => {},
      );
      attachHostPluginSettings(sanitized, pluginSettingsByHost);

      return res.json(sanitized);
    } catch (error) {
      sshLogger.error("Failed to fetch SSH hosts from database", error, {
        operation: "host_fetch",
        userId,
      });
      return res.status(500).json({ error: "Failed to fetch SSH data" });
    }
  },
);

/**
 * @openapi
 * /host/db/host/{id}:
 *   get:
 *     summary: Get SSH host by ID
 *     description: Retrieves a host owned by the authenticated Owner.
 *     tags:
 *       - SSH
 */
router.get(
  "/db/host/:id",
  authenticateJWT,
  permissionManager.requirePermission("hosts.view"),
  requireDataAccess,
  async (req: Request, res: Response) => {
    const hostId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;
    const userId = (req as AuthenticatedRequest).userId;

    if (!isNonEmptyString(userId) || !hostId) {
      return res.status(400).json({ error: "Invalid userId or hostId" });
    }

    try {
      const host =
        await createCurrentHostResolutionRepository().findHostByIdForUser(
          Number(hostId),
          userId,
        );

      if (!host) {
        return res.status(404).json({ error: "SSH host not found" });
      }

      const transformed = transformHostResponse(host);
      const resolved =
        (await resolveHostCredentials(transformed, userId)) || transformed;

      return res.json(
        await withHostPluginSettings(
          await withProtocolAuth(stripSensitiveFields(resolved)),
        ),
      );
    } catch (error) {
      sshLogger.error("Failed to fetch SSH host by ID from database", error, {
        operation: "host_fetch_by_id",
        hostId: Number(hostId),
        userId,
      });
      return res.status(500).json({ error: "Failed to fetch SSH host" });
    }
  },
);

/**
 * @openapi
 * /host/db/host/{id}/password:
 *   get:
 *     summary: Get host password for clipboard copy
 *     description: Returns the password for a specific host. Used by the copy-password feature.
 *     tags:
 *       - SSH
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: field
 *         schema:
 *           type: string
 *           enum: [password, sudoPassword, key, keyPassword]
 *       - in: query
 *         name: protocol
 *         schema:
 *           type: string
 *         description: A plugin protocol id; returns that protocol's saved password instead of field.
 *     responses:
 *       200:
 *         description: The requested password value.
 *       404:
 *         description: Host not found or no password set.
 */
router.get(
  "/db/host/:id/password",
  authenticateJWT,
  requireDataAccess,
  async (req: Request, res: Response) => {
    const hostId = Number(req.params.id);
    const userId = (req as AuthenticatedRequest).userId;
    const field = (req.query.field as string) || "password";
    const coreField = [
      "password",
      "sudoPassword",
      "key",
      "keyPassword",
    ].includes(field);
    // 2.8 clients ask for "<protocol>Password".
    const protocol =
      typeof req.query.protocol === "string"
        ? req.query.protocol
        : coreField
          ? undefined
          : /^([a-z][a-zA-Z0-9]*)Password$/.exec(field)?.[1];
    const protocolId = protocol ? findHostProtocol(protocol)?.id : undefined;

    if (!protocolId && (protocol || !coreField)) {
      return res.status(400).json({ error: "Invalid field" });
    }

    try {
      const host =
        await createCurrentHostResolutionRepository().findHostByIdForUser(
          hostId,
          userId,
        );

      if (!host) {
        return res.status(404).json({ error: "Host not found" });
      }

      if (protocolId) {
        const login = (await listProtocolLogins(hostId, userId)).find(
          (entry) => entry.protocol === protocolId,
        );
        if (!login?.password) {
          return res.status(404).json({ error: "No password set" });
        }
        return res.json({ value: login.password });
      }

      const resolved = (await resolveHostCredentials(host, userId)) || host;
      let value = resolved[field];

      if (!value && field === "sudoPassword") {
        value = hostTerminalExport(resolved).sudoPassword || null;
      }

      if (!value) {
        return res.status(404).json({ error: "No password set" });
      }

      res.json({ value });
    } catch (err) {
      sshLogger.error("Failed to fetch host password", err, {
        operation: "host_password_fetch",
        hostId,
        userId,
      });
      res.status(500).json({ error: "Failed to fetch password" });
    }
  },
);

/**
 * @openapi
 * /host/db/host/{id}/export:
 *   get:
 *     summary: Export SSH host
 *     description: Exports a specific SSH host with decrypted credentials.
 *     tags:
 *       - SSH
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: The exported SSH host.
 *       400:
 *         description: Invalid userId or hostId.
 *       404:
 *         description: SSH host not found.
 *       500:
 *         description: Failed to export SSH host.
 */
router.get(
  "/db/host/:id/export",
  authenticateJWT,
  requireDataAccess,
  async (req: Request, res: Response) => {
    const hostId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;
    const userId = (req as AuthenticatedRequest).userId;

    if (!isNonEmptyString(userId) || !hostId) {
      return res.status(400).json({ error: "Invalid userId or hostId" });
    }

    try {
      const host =
        await createCurrentHostResolutionRepository().findHostByIdForUser(
          Number(hostId),
          userId,
        );

      if (!host) {
        return res.status(404).json({ error: "SSH host not found" });
      }

      const resolvedHost = (await resolveHostCredentials(host, userId)) || host;
      const hostPluginSettings = (
        await loadHostPluginSettings([Number(hostId)])
      ).get(Number(hostId));

      const exportedConnectionType =
        (resolvedHost.connectionType as string) || "ssh";
      const isRemoteDesktop = exportedConnectionType !== "ssh";

      const baseExportData = {
        exportId: resolvedHost.id,
        connectionType: exportedConnectionType,
        name: resolvedHost.name,
        ip: resolvedHost.ip,
        port: resolvedHost.port,
        username: resolvedHost.username,
        password: resolvedHost.password || null,
        folder: resolvedHost.folder,
        tags:
          typeof resolvedHost.tags === "string"
            ? resolvedHost.tags.split(",").filter(Boolean)
            : resolvedHost.tags || [],
        pin: !!resolvedHost.pin,
        notes: resolvedHost.notes || null,
        // Every plugin's host settings, secrets redacted, for import to hand back.
        pluginSettings: hostPluginSettings ?? {},
        // Each plugin protocol's login, secrets included like the SSH ones.
        protocolAuth: toPortableLogins(
          await listProtocolLogins(Number(hostId), userId),
        ),
      };

      const exportData = isRemoteDesktop
        ? baseExportData
        : {
            ...baseExportData,
            authType: resolvedHost.authType,
            key: resolvedHost.key || null,
            keyPassword: resolvedHost.keyPassword || null,
            keyType: resolvedHost.keyType || null,
            credentialId: resolvedHost.credentialId || null,
            overrideCredentialUsername:
              !!resolvedHost.overrideCredentialUsername,
            sudoPassword:
              resolvedHost.sudoPassword ||
              hostTerminalExport(resolvedHost).sudoPassword ||
              null,
            jumpHosts: resolvedHost.jumpHosts
              ? JSON.parse(resolvedHost.jumpHosts as string)
              : null,
            terminalConfig:
              hostTerminalExport(resolvedHost).terminalConfig ?? null,
            sshOptions: hostTerminalExport(resolvedHost).sshOptions,
            forceKeyboardInteractive:
              resolvedHost.forceKeyboardInteractive === "true",
            portKnockSequence: resolvedHost.portKnockSequence
              ? JSON.parse(resolvedHost.portKnockSequence as string)
              : null,
          };

      sshLogger.success("Host exported with decrypted credentials", {
        operation: "host_export",
        hostId: parseInt(hostId),
        userId,
      });

      res.json(exportData);
    } catch (err) {
      sshLogger.error("Failed to export SSH host", err, {
        operation: "host_export",
        hostId: parseInt(hostId),
        userId,
      });
      res.status(500).json({ error: "Failed to export SSH host" });
    }
  },
);

/**
 * @openapi
 * /host/db/hosts/export:
 *   get:
 *     summary: Export all SSH hosts
 *     description: Exports all hosts owned by the authenticated Owner.
 *     tags:
 *       - SSH
 */
router.get(
  "/db/hosts/export",
  authenticateJWT,
  requireDataAccess,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    if (!isNonEmptyString(userId)) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    try {
      const allHosts =
        await createCurrentHostResolutionRepository().findHostsByUserId(userId);
      const pluginSettingsByHost = await loadHostPluginSettings(
        allHosts.map((host) => host.id as number),
      );

      const exportedHosts = [];
      for (const host of allHosts) {
        const resolvedHost =
          (await resolveHostCredentials(host, userId)) || host;
        const hostPluginSettings = pluginSettingsByHost.get(host.id as number);

        const baseExportData = {
          exportId: resolvedHost.id,
          connectionType: (resolvedHost.connectionType as string) || "ssh",
          name: resolvedHost.name,
          ip: resolvedHost.ip,
          port: resolvedHost.port,
          username: resolvedHost.username,
          password: resolvedHost.password || null,
          folder: resolvedHost.folder,
          tags:
            typeof resolvedHost.tags === "string"
              ? resolvedHost.tags.split(",").filter(Boolean)
              : resolvedHost.tags || [],
          pin: !!resolvedHost.pin,
          notes: resolvedHost.notes || null,
          pluginSettings: hostPluginSettings ?? {},
          protocolAuth: toPortableLogins(
            await listProtocolLogins(host.id as number, userId),
          ),
        };

        exportedHosts.push({
          ...baseExportData,
          authType: resolvedHost.authType,
          key: resolvedHost.key || null,
          keyPassword: resolvedHost.keyPassword || null,
          keyType: resolvedHost.keyType || null,
          credentialId: resolvedHost.credentialId || null,
          overrideCredentialUsername: !!resolvedHost.overrideCredentialUsername,
          sudoPassword:
            resolvedHost.sudoPassword ||
            hostTerminalExport(resolvedHost).sudoPassword ||
            null,
          jumpHosts: resolvedHost.jumpHosts
            ? JSON.parse(resolvedHost.jumpHosts as string)
            : null,
          terminalConfig:
            hostTerminalExport(resolvedHost).terminalConfig ?? null,
          sshOptions: hostTerminalExport(resolvedHost).sshOptions,
          forceKeyboardInteractive:
            resolvedHost.forceKeyboardInteractive === "true",
          portKnockSequence: resolvedHost.portKnockSequence
            ? JSON.parse(resolvedHost.portKnockSequence as string)
            : null,
        });
      }

      sshLogger.success("All hosts exported with decrypted credentials", {
        operation: "hosts_export_all",
        count: exportedHosts.length,
        userId,
      });

      return res.json({ hosts: exportedHosts });
    } catch (error) {
      sshLogger.error("Failed to export all SSH hosts", error, {
        operation: "hosts_export_all",
        userId,
      });
      return res.status(500).json({ error: "Failed to export SSH hosts" });
    }
  },
);

/**
 * @openapi
 * /host/db/host/{id}:
 *   delete:
 *     summary: Delete SSH host
 *     description: Deletes an SSH host by its ID.
 *     tags:
 *       - SSH
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: SSH host deleted successfully.
 *       400:
 *         description: Invalid userId or id.
 *       404:
 *         description: SSH host not found.
 *       500:
 *         description: Failed to delete SSH host.
 */
router.delete(
  "/db/host/:id",
  authenticateJWT,
  permissionManager.requirePermission("hosts.delete"),
  requireDataAccess,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const hostId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;

    if (!isNonEmptyString(userId) || !hostId) {
      sshLogger.warn("Invalid userId or hostId for SSH host delete", {
        operation: "host_delete",
        hostId: parseInt(hostId),
        userId,
      });
      return res.status(400).json({ error: "Invalid userId or id" });
    }
    databaseLogger.info("Deleting SSH host", {
      operation: "host_delete",
      userId,
      hostId: parseInt(hostId),
    });
    try {
      const deleted = await deleteOwnedHost(userId, Number(hostId));

      if (!deleted) {
        sshLogger.warn("SSH host not found for deletion", {
          operation: "host_delete",
          hostId: parseInt(hostId),
          userId,
        });
        return res.status(404).json({ error: "SSH host not found" });
      }

      databaseLogger.success("SSH host deleted", {
        operation: "host_delete_success",
        userId,
        hostId: parseInt(hostId),
      });

      const { ipAddress: dhIp, userAgent: dhUa } = getRequestMeta(req);
      await logAudit({
        userId,
        username: await getAuditUsername(userId),
        action: "delete_host",
        resourceType: "host",
        resourceId: hostId,
        resourceName: deleted.name,
        ipAddress: dhIp,
        userAgent: dhUa,
        success: true,
      });

      res.json({ message: "SSH host deleted" });
    } catch (err) {
      sshLogger.error("Failed to delete SSH host from database", err, {
        operation: "host_delete",
        hostId: parseInt(hostId),
        userId,
      });
      res.status(500).json({ error: "Failed to delete SSH host" });
    }
  },
);

// File manager recent/pinned/shortcuts and transfer/recent routes moved to
// the file-manager plugin, under /plugin-api/file-manager/, and command
// history to the ssh-terminal plugin, under /plugin-api/ssh-terminal/.

async function resolveHostCredentials(
  host: Record<string, unknown>,
  _requestingUserId?: string,
  /**
   * Credentials already fetched for this request, keyed by id. The host list
   * preloads them in one query; single-host callers omit it and fall back to
   * fetching the one credential they need.
   */
  preloadedCredentials?: Map<number, HostResolutionCredentialRecord>,
): Promise<Record<string, unknown>> {
  try {
    if (host.credentialId && (host.userId || host.ownerId)) {
      const credentialId = host.credentialId as number;
      const credentialOwnerId = (host.ownerId || host.userId) as string;

      const credential =
        preloadedCredentials?.get(credentialId) ??
        (await findUsableCredential(credentialId, credentialOwnerId));

      if (credential) {
        const resolvedHost: Record<string, unknown> = {
          ...host,
          password: pickResolvedPassword(host.password, credential.password),
          key: credential.key,
          keyPassword: credential.keyPassword,
          keyType: credential.keyType,
        };

        const resolvedUsername = pickResolvedUsername(
          host.username,
          credential.username,
          host.overrideCredentialUsername,
        );
        if (resolvedUsername !== undefined) {
          resolvedHost.username = resolvedUsername;
        }

        return resolvedHost;
      }
    }

    return { ...host };
  } catch (error) {
    sshLogger.warn(
      `Failed to resolve credentials for host ${host.id}: ${getErrorMessage(error)}`,
    );
    return host;
  }
}

registerHostFolderRoutes(router, {
  authenticateJWT,
  requireViewPermission: permissionManager.requirePermission("hosts.view"),
  requireEditPermission: permissionManager.requirePermission("hosts.edit"),
  requireDeletePermission: permissionManager.requirePermission("hosts.delete"),
  requireCredentialEditPermission:
    permissionManager.requirePermission("credentials.edit"),
  requireDataAccess,
});

registerHostBulkRoutes(
  router,
  authenticateJWT,
  permissionManager.requirePermission("hosts.create"),
  permissionManager.requirePermission("hosts.edit"),
  requireDataAccess,
);


registerHostDefaultsRoutes(router, {
  authenticateJWT,
  requireEditPermission: permissionManager.requirePermission("hosts.edit"),
  requireDataAccess,
  requireAdminSettings: permissionManager.requirePermission(
    "admin.settings.manage",
  ),
});

export default router;

/** Seconds between status checks, or null to follow the global setting. */
function normalizeStatusInterval(value: unknown): number | null {
  const seconds = Number(value);
  if (value === null || value === undefined || value === "") return null;
  return Number.isInteger(seconds) && seconds >= 5 && seconds <= 86400
    ? seconds
    : null;
}
