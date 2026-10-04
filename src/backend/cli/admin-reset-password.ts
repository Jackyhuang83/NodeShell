import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function fail(message: string): never {
  process.stderr.write(`NodeShell recovery: ${message}\n`);
  process.exit(1);
}

async function readPasswordFile(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("password file must be a regular file, not a symlink");
  }
  if ((stat.mode & 0o077) !== 0) {
    fail("password file must not be readable or writable by group/others (use chmod 600)");
  }
  if (stat.size < 12 || stat.size > 4096) {
    fail("password file must contain a password between 12 and 4096 bytes");
  }

  const buffer = await fs.readFile(absolute);
  try {
    let password = buffer.toString("utf8");
    password = password.replace(/\r?\n$/, "");
    if (password.includes("\n") || password.includes("\r") || password.includes("\0")) {
      fail("password file must contain exactly one password");
    }
    if (password.length < 12) {
      fail("new password must be at least 12 characters");
    }
    return password;
  } finally {
    buffer.fill(0);
  }
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });

  const username = argValue("--username")?.trim();
  const passwordFile = argValue("--password-file");
  const confirmDataWipe = hasFlag("--confirm-data-wipe");

  if (!username || !passwordFile) {
    fail(
      "usage: admin-reset-password --username <owner> --password-file <0600-file> [--confirm-data-wipe]",
    );
  }

  if (process.argv.includes("--password")) {
    fail("plaintext --password arguments are forbidden; use --password-file");
  }

  const newPassword = await readPasswordFile(passwordFile);

  const { SystemCrypto } = await import("../utils/system-crypto.js");
  const systemCrypto = SystemCrypto.getInstance();
  await systemCrypto.initializeJWTSecret();
  await systemCrypto.initializeDatabaseKey();
  await systemCrypto.initializeEncryptionKey();
  await systemCrypto.initializeInternalAuthToken();

  const { initializeDatabase, saveMemoryDatabaseToFile } =
    await import("../database/db/index.js");
  await initializeDatabase();

  const { UserKeyManager } = await import("../utils/user-keys.js");
  await UserKeyManager.getInstance().initialize();

  const { AuthManager } = await import("../utils/auth-manager.js");
  const authManager = AuthManager.getInstance();
  await authManager.initialize();

  const { createCurrentUserRepository } =
    await import("../database/repositories/factory.js");
  const user = await createCurrentUserRepository().findByUsername(username);
  if (!user) fail("owner account not found");
  if (!user.isAdmin) fail("recovery CLI only resets an administrator account");

  const { resetUserPassword } =
    await import("../database/routes/user-password-reset-routes.js");
  const outcome = await resetUserPassword(authManager, {
    userId: user.id,
    username: user.username,
    newPassword,
    confirmDataWipe,
  });

  if (outcome.status === "wipe_confirmation_required") {
    fail(
      "legacy password-wrapped data cannot be recovered without the old password; rerun with --confirm-data-wipe only if permanent deletion of this user's encrypted data is intended",
    );
  }

  const { resolveDatabaseDialect } =
    await import("../database/db/dialect.js");
  if (resolveDatabaseDialect() === "sqlite") {
    await saveMemoryDatabaseToFile();
  }

  process.stdout.write(
    outcome.dataWiped
      ? "NodeShell owner password reset; legacy encrypted user data was wiped as explicitly confirmed.\n"
      : "NodeShell owner password reset; encrypted user data was preserved.\n",
  );
}

main().catch((error) => {
  process.stderr.write(
    `NodeShell recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
