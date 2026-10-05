import bcrypt from "bcryptjs";
import type { AuthManager } from "../../utils/auth-manager.js";
import { authLogger } from "../../utils/logger.js";
import {
  createCurrentCredentialRepository,
  createCurrentHostRepository,
  createCurrentRecentActivityRepository,
  createCurrentSshCredentialUsageRepository,
  createCurrentUserRepository,
  createCurrentUserAuthRepository,
  createCurrentTrustedDeviceRepository,
} from "../repositories/factory.js";
import { pluginEvents, TOPICS } from "../../plugins/events.js";

export type PasswordResetOutcome =
  | { status: "reset"; dataWiped: false }
  | { status: "reset"; dataWiped: true }
  | { status: "wipe_confirmation_required" };

/**
 * Internal recovery primitive only.
 *
 * NodeShell intentionally exposes no browser password-reset route. An
 * operator-only local CLI may call this after initializing the encrypted
 * database and system key material.
 *
 * For a v3 system-wrapped DEK, changing the password preserves encrypted
 * user data. A legacy password-wrapped DEK cannot be recovered without the
 * old password; callers must explicitly confirm the destructive wipe.
 */
export async function resetUserPassword(
  authManager: AuthManager,
  options: {
    userId: string;
    username: string;
    newPassword: string;
    confirmDataWipe: boolean;
  },
): Promise<PasswordResetOutcome> {
  const { userId, username, newPassword, confirmDataWipe } = options;
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const userRepository = createCurrentUserRepository();

  if (authManager.isUserUnlocked(userId)) {
    await userRepository.update(userId, { passwordHash });
    await authManager.logoutUser(userId);

    authLogger.success("Password reset locally with data preserved", {
      operation: "password_reset_preserved",
      userId,
      username,
    });
    return { status: "reset", dataWiped: false };
  }

  if (!confirmDataWipe) {
    return { status: "wipe_confirmation_required" };
  }

  await userRepository.update(userId, { passwordHash });

  await createCurrentSshCredentialUsageRepository().deleteByUserId(userId);
  await createCurrentRecentActivityRepository().deleteByUserId(userId);
  await createCurrentHostRepository().deleteByUserId(userId);
  await createCurrentCredentialRepository().deleteByUserId(userId);
  pluginEvents.emit(TOPICS.userDataWiped, { userId });

  const { UserKeyManager } = await import("../../utils/user-keys.js");
  await UserKeyManager.getInstance().rotateUserDEK(userId);
  const { deleteLegacyWraps } =
    await import("../../utils/crypto-migration/dek-migration.js");
  await deleteLegacyWraps(userId);
  await authManager.logoutUser(userId);

  // Clear legacy browser-2FA state so an upgraded database cannot retain
  // stale enrolments or trusted-device bypasses after local recovery.
  await createCurrentUserAuthRepository().clearSecondFactors(userId);
  await createCurrentTrustedDeviceRepository().deleteByUserId(userId);

  authLogger.warn("Password reset locally after destructive data wipe", {
    operation: "password_reset_data_deleted",
    userId,
    username,
  });
  return { status: "reset", dataWiped: true };
}
