import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function fail(message: string): never {
  process.stderr.write(`NodeShell owner setup: ${message}\n`);
  process.exit(1);
}

async function readPasswordFile(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("password file must be a regular file, not a symlink");
  }
  if ((stat.mode & 0o077) !== 0) {
    fail("password file must be owner-only (chmod 600 or stricter)");
  }
  if (stat.size < 12 || stat.size > 4096) {
    fail("password file must contain a password between 12 and 4096 bytes");
  }

  const buffer = await fs.readFile(absolute);
  try {
    let password = buffer.toString("utf8").replace(/\r?\n$/, "");
    if (password.includes("\n") || password.includes("\r") || password.includes("\0")) {
      fail("password file must contain exactly one password");
    }
    if (password.length < 12) {
      fail("owner password must be at least 12 characters");
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

  if (!username || !passwordFile) {
    fail(
      "usage: admin-create-owner --username <owner> --password-file <0600-file>",
    );
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
    fail("username must be 1-64 characters using letters, digits, dot, underscore or dash");
  }
  if (process.argv.includes("--password")) {
    fail("plaintext --password arguments are forbidden; use --password-file");
  }

  const password = await readPasswordFile(passwordFile);

  const { SystemCrypto } = await import("../utils/system-crypto.js");
  const systemCrypto = SystemCrypto.getInstance();
  await systemCrypto.initializeJWTSecret();
  await systemCrypto.initializeDatabaseKey();
  await systemCrypto.initializeEncryptionKey();
  await systemCrypto.initializeInternalAuthToken();

  const { initializeDatabase, saveMemoryDatabaseToFile } =
    await import("../database/db/index.js");
  await initializeDatabase();

  const {
    createCurrentRoleRepository,
    createCurrentUserRepository,
  } = await import("../database/repositories/factory.js");
  const userRepository = createCurrentUserRepository();
  if ((await userRepository.countAll()) !== 0) {
    fail("an account already exists; browser registration remains disabled");
  }

  const { UserKeyManager } = await import("../utils/user-keys.js");
  await UserKeyManager.getInstance().initialize();

  const passwordHash = await bcrypt.hash(password, 10);
  const id = crypto.randomUUID();
  const { user, isFirstUser } = await userRepository.createFirstLocalUser({
    id,
    username,
    passwordHash,
    isOidc: false,
    clientId: "",
    clientSecret: "",
    issuerUrl: "",
    authorizationUrl: "",
    tokenUrl: "",
    identifierPath: "",
    namePath: "",
    scopes: "openid email profile",
  });

  if (!isFirstUser || !user.isAdmin) {
    fail("refusing owner setup because the account was not created as first administrator");
  }

  await createCurrentRoleRepository().assignRoleNameToUser({
    userId: user.id,
    roleName: "admin",
    grantedBy: user.id,
  });

  const { AuthManager } = await import("../utils/auth-manager.js");
  const authManager = AuthManager.getInstance();
  await authManager.initialize();
  await authManager.registerUser(user.id);

  const { resolveDatabaseDialect } =
    await import("../database/db/dialect.js");
  if (resolveDatabaseDialect() === "sqlite") {
    await saveMemoryDatabaseToFile();
  }

  process.stdout.write(
    `NodeShell owner "${username}" created. Browser registration is disabled.\n`,
  );
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(
    `NodeShell owner setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
