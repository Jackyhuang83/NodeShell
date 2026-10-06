import { getErrorMessage } from "../../utils/error-message.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";
import fs from "fs";
import path from "path";
import { databaseLogger } from "../../utils/logger.js";
import { DatabaseFileEncryption } from "../../utils/database-file-encryption.js";
import { SystemCrypto } from "../../utils/system-crypto.js";
import { DatabaseMigration } from "../../utils/database-migration.js";
import { DatabaseSaveTrigger } from "../../utils/database-save-trigger.js";
import { migrateAuditRetention } from "../../utils/audit-retention-migration.js";
import { createPerformanceIndexes } from "./performance-indexes.js";
import {
  assertDataDirIsNotMisconfigured,
  DataDirMisconfiguredError,
} from "../../utils/data-dir-guard.js";
import type { PortableDatabase } from "../repositories/database-context.js";

const dataDir = process.env.DATA_DIR || "./db/data";
const dbDir = path.resolve(dataDir);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const enableFileEncryption = process.env.DB_FILE_ENCRYPTION !== "false";
const dbPath = path.join(dataDir, "db.sqlite");
const encryptedDbPath = `${dbPath}.encrypted`;

const actualDbPath = ":memory:";
let memoryDatabase: Database.Database;
let isNewDatabase = false;
let sqlite: Database.Database;

function getRawSettingValue(key: string): string | null {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value?: string } | undefined;

  return row?.value ?? null;
}

function setRawSettingValue(key: string, value: string): void {
  sqlite
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, value);
}

function ensureRawSettingDefault(key: string, value: string): void {
  if (getRawSettingValue(key) === null) {
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(key, value);
  }
}

async function initializeDatabaseAsync(): Promise<void> {
  const systemCrypto = SystemCrypto.getInstance();

  await systemCrypto.getDatabaseKey();
  if (enableFileEncryption) {
    try {
      if (DatabaseFileEncryption.isEncryptedDatabaseFile(encryptedDbPath)) {
        const decryptedBuffer =
          await DatabaseFileEncryption.decryptDatabaseToBuffer(encryptedDbPath);

        memoryDatabase = new Database(decryptedBuffer);

        try {
          memoryDatabase
            .prepare("SELECT COUNT(*) as count FROM sessions")
            .get() as { count: number };
        } catch {
          // expected - sessions table may not exist yet
        }
      } else {
        const migration = new DatabaseMigration(dataDir);
        const migrationStatus = migration.checkMigrationStatus();

        if (migrationStatus.needsMigration) {
          const migrationResult = await migration.migrateDatabase();

          if (migrationResult.success) {
            migration.cleanupOldBackups();

            if (
              DatabaseFileEncryption.isEncryptedDatabaseFile(encryptedDbPath)
            ) {
              const decryptedBuffer =
                await DatabaseFileEncryption.decryptDatabaseToBuffer(
                  encryptedDbPath,
                );
              memoryDatabase = new Database(decryptedBuffer);
              isNewDatabase = false;
            } else {
              throw new Error(
                "Migration completed but encrypted database file not found",
              );
            }
          } else {
            databaseLogger.error("Automatic database migration failed", null, {
              operation: "auto_migration_failed",
              error: migrationResult.error,
              migratedTables: migrationResult.migratedTables,
              migratedRows: migrationResult.migratedRows,
              duration: migrationResult.duration,
              backupPath: migrationResult.backupPath,
            });
            throw new Error(
              `Database migration failed: ${migrationResult.error}. Backup available at: ${migrationResult.backupPath}`,
            );
          }
        } else {
          assertDataDirIsNotMisconfigured(dataDir);
          memoryDatabase = new Database(":memory:");
          isNewDatabase = true;
        }
      }
    } catch (error) {
      // Not a decryption problem: the database is fine, we are pointed at the
      // wrong directory. Surface that message as-is.
      if (error instanceof DataDirMisconfiguredError) throw error;

      databaseLogger.error("Failed to initialize memory database", error, {
        operation: "db_memory_init_failed",
        errorMessage: getErrorMessage(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        encryptedDbExists:
          DatabaseFileEncryption.isEncryptedDatabaseFile(encryptedDbPath),
        databaseKeyAvailable: !!process.env.DATABASE_KEY,
        databaseKeyLength: process.env.DATABASE_KEY?.length || 0,
      });

      try {
        const diagnosticInfo =
          DatabaseFileEncryption.getDiagnosticInfo(encryptedDbPath);
        databaseLogger.error(
          "Database encryption diagnostic completed - check logs above for details",
          null,
          {
            operation: "db_encryption_diagnostic_completed",
            filesConsistent: diagnosticInfo.validation.filesConsistent,
            sizeMismatch: diagnosticInfo.validation.sizeMismatch,
          },
        );
      } catch (diagError) {
        databaseLogger.warn("Failed to generate diagnostic information", {
          operation: "db_diagnostic_failed",
          error:
            getErrorMessage(diagError),
        });
      }

      throw new Error(
        `Database decryption failed: ${getErrorMessage(error)}. This prevents data loss.`,
        { cause: error },
      );
    }
  } else {
    assertDataDirIsNotMisconfigured(dataDir);

    // The database still lives in memory and is serialised out on every write;
    // turning encryption off only changes whether that file is ciphertext. It
    // has to be read back, or each restart starts empty and silently discards
    // everything the previous run saved.
    const existing = readPlainDatabaseFile();
    if (existing) {
      memoryDatabase = new Database(existing);
      databaseLogger.info("Loaded unencrypted database from disk", {
        operation: "db_load_plain",
        path: dbPath,
        bytes: existing.length,
      });
    } else {
      memoryDatabase = new Database(":memory:");
      isNewDatabase = true;
    }
  }
}

/** The plain database file, or null when there is nothing to restore. */
function readPlainDatabaseFile(): Buffer | null {
  try {
    const contents = fs.readFileSync(dbPath);
    return contents.length > 0 ? contents : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function initializeCompleteDatabase(): Promise<void> {
  await initializeDatabaseAsync();

  databaseLogger.info(`Initializing SQLite database`, {
    operation: "db_init",
    path: actualDbPath,
    encrypted:
      enableFileEncryption &&
      DatabaseFileEncryption.isEncryptedDatabaseFile(encryptedDbPath),
    inMemory: true,
    isNewDatabase,
  });

  sqlite = memoryDatabase;

  sqlite.exec("PRAGMA foreign_keys = ON");

  db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_oidc INTEGER NOT NULL DEFAULT 0,
        oidc_identifier TEXT,
        client_id TEXT,
        client_secret TEXT,
        issuer_url TEXT,
        authorization_url TEXT,
        token_url TEXT,
        identifier_path TEXT,
        name_path TEXT,
        scopes TEXT DEFAULT 'openid email profile',
        registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        donation_modal_dismissed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        jwt_token TEXT NOT NULL,
        device_type TEXT NOT NULL,
        device_info TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trusted_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_fingerprint TEXT NOT NULL,
        device_type TEXT NOT NULL,
        device_info TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_external_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (provider_id, subject),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_external_identities_user ON user_external_identities (user_id);

    CREATE TABLE IF NOT EXISTS user_second_factors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        factor_id TEXT NOT NULL,
        enrolled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, plugin_id, factor_id),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ssh_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        name TEXT,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        folder TEXT,
        tags TEXT,
        pin INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER,
        auth_type TEXT NOT NULL,
        password TEXT,
        key TEXT,
        key_password TEXT,
        key_type TEXT,
        force_keyboard_interactive TEXT,
        status_check_enabled INTEGER NOT NULL DEFAULT 1,
        status_check_interval INTEGER,
        terminal_config TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ssh_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        folder TEXT,
        tags TEXT,
        auth_type TEXT NOT NULL,
        username TEXT,
        password TEXT,
        key TEXT,
        key_password TEXT,
        key_type TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ssh_credential_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id INTEGER NOT NULL,
        host_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (credential_id) REFERENCES ssh_credentials (id) ON DELETE CASCADE,
        FOREIGN KEY (host_id) REFERENCES ssh_data (id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ssh_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        icon TEXT,
        credential_id INTEGER,
        sort_order INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (credential_id) REFERENCES ssh_credentials (id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS recent_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        host_name TEXT,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (host_id) REFERENCES ssh_data (id) ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        resource_name TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        success INTEGER NOT NULL,
        error_message TEXT,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
    );


    CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'available',
        source TEXT NOT NULL DEFAULT 'community',
        registry_id TEXT,
        state TEXT NOT NULL DEFAULT 'disabled',
        last_error TEXT,
        installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        auto_update INTEGER NOT NULL DEFAULT 0,
        manifest_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plugins_registry_id ON plugins (registry_id);

    CREATE TABLE IF NOT EXISTS plugin_permission_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        -- Nullable: a bundled grant is made by the install, not by a user.
        granted_by TEXT,
        source TEXT NOT NULL DEFAULT 'admin',
        UNIQUE (plugin_id, capability),
        FOREIGN KEY (plugin_id) REFERENCES plugins (id) ON DELETE CASCADE,
        FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plugin_registries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'community',
        enabled INTEGER NOT NULL DEFAULT 1,
        signing_key TEXT,
        last_checked_at TEXT,
        last_index_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS plugin_install_counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        registry_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'aggregate-telemetry',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (plugin_id, registry_id)
    );

    CREATE TABLE IF NOT EXISTS plugin_storage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (plugin_id, key),
        FOREIGN KEY (plugin_id) REFERENCES plugins (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plugin_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (plugin_id, migration_id),
        FOREIGN KEY (plugin_id) REFERENCES plugins (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS plugin_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT,
        key TEXT NOT NULL,
        value TEXT,
        encrypted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (plugin_id, scope, scope_id, key),
        FOREIGN KEY (plugin_id) REFERENCES plugins (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_settings_plugin_scope ON plugin_settings (plugin_id, scope);


    CREATE TABLE IF NOT EXISTS user_open_tabs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tab_type TEXT NOT NULL,
        host_id INTEGER,
        label TEXT NOT NULL,
        tab_order INTEGER NOT NULL DEFAULT 0,
        backend_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (host_id) REFERENCES ssh_data (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY,
        reopen_tabs_on_login INTEGER NOT NULL DEFAULT 0,
        theme TEXT,
        font_size TEXT,
        accent_color TEXT,
        language TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS host_sidebar_preferences (
        user_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credential_sidebar_preferences (
        user_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ui_preferences (
        user_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

`);

  // Expired open tabs are dropped when the tab list is read, against the
  // terminal plugin's own session timeout.

  try {
    const result = sqlite
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(new Date().toISOString());
    if (result.changes > 0) {
      databaseLogger.info("Expired sessions cleaned up on startup", {
        operation: "db_init_session_cleanup",
        deletedSessions: result.changes,
      });
    }
  } catch (e) {
    databaseLogger.warn("Could not clear expired sessions on startup", {
      operation: "db_init_session_cleanup_failed",
      error: e,
    });
  }

  migrateSchema();
  vacuumIfFreelistBloated();

  try {
    ensureRawSettingDefault("allow_registration", "true");
  } catch (e) {
    databaseLogger.warn("Could not initialize default settings", {
      operation: "db_init",
      error: e,
    });
  }

  try {
    ensureRawSettingDefault("allow_password_login", "true");
  } catch (e) {
    databaseLogger.warn("Could not initialize allow_password_login setting", {
      operation: "db_init",
      error: e,
    });
  }
}

const addColumnIfNotExists = (
  table: string,
  column: string,
  definition: string,
) => {
  try {
    sqlite
      .prepare(
        `SELECT "${column}"
                        FROM ${table} LIMIT 1`,
      )
      .get();
  } catch {
    try {
      sqlite.exec(`ALTER TABLE ${table}
                ADD COLUMN "${column}" ${definition};`);
    } catch (alterError) {
      const message =
        alterError instanceof Error ? alterError.message : String(alterError);
      databaseLogger.warn(
        `Failed to add column ${column} to ${table}: ${message}`,
        {
          operation: "schema_migration",
          table,
          column,
        },
      );
    }
  }
};

/**
 * Drops the NOT NULL on plugin_permission_grants.granted_by.
 *
 * A bundled grant is made by the install rather than by a person, so there is
 * no user id to record. SQLite cannot relax a constraint in place, so the
 * table is rebuilt; it only ever holds a handful of rows.
 */
const relaxPluginGrantGrantedBy = () => {
  try {
    const sql = sqlite
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plugin_permission_grants'`,
      )
      .get() as { sql?: string } | undefined;

    if (!sql?.sql || !/granted_by\s+TEXT\s+NOT\s+NULL/i.test(sql.sql)) {
      return;
    }

    sqlite.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE plugin_permission_grants_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          capability TEXT NOT NULL,
          granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          granted_by TEXT,
          source TEXT NOT NULL DEFAULT 'admin',
          UNIQUE (plugin_id, capability),
          FOREIGN KEY (plugin_id) REFERENCES plugins (id) ON DELETE CASCADE,
          FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE CASCADE
      );
      INSERT INTO plugin_permission_grants_new
          (id, plugin_id, capability, granted_at, granted_by, source)
          SELECT id, plugin_id, capability, granted_at, granted_by, 'admin'
          FROM plugin_permission_grants;
      DROP TABLE plugin_permission_grants;
      ALTER TABLE plugin_permission_grants_new RENAME TO plugin_permission_grants;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);

    databaseLogger.info(
      "Relaxed plugin_permission_grants.granted_by to allow bundled grants",
      { operation: "schema_migration" },
    );
  } catch (error) {
    databaseLogger.warn(
      `Failed to relax plugin_permission_grants.granted_by: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { operation: "schema_migration" },
    );
  }
};

const migrateSchema = () => {
  addColumnIfNotExists("user_preferences", "theme", "TEXT");
  addColumnIfNotExists("user_preferences", "font_size", "TEXT");
  addColumnIfNotExists("user_preferences", "accent_color", "TEXT");
  addColumnIfNotExists("user_preferences", "language", "TEXT");
  addColumnIfNotExists("user_preferences", "storage_mode", "TEXT");
  addColumnIfNotExists("user_preferences", "command_autocomplete", "INTEGER");
  addColumnIfNotExists("user_preferences", "command_palette_enabled", "INTEGER");
  addColumnIfNotExists("user_preferences", "show_host_tags", "INTEGER");
  addColumnIfNotExists("user_preferences", "host_tray_on_click", "INTEGER");
  addColumnIfNotExists("user_preferences", "pin_app_rail", "INTEGER");
  addColumnIfNotExists(
    "user_preferences",
    "expand_app_rail_on_hover",
    "INTEGER",
  );
  addColumnIfNotExists(
    "user_preferences",
    "show_pin_app_rail_button",
    "INTEGER",
  );
  addColumnIfNotExists("user_preferences", "folders_collapsed", "INTEGER");
  addColumnIfNotExists("user_preferences", "confirm_snippet_execution", "INTEGER");
  addColumnIfNotExists("user_preferences", "disable_update_check", "INTEGER");
  addColumnIfNotExists("user_preferences", "confirm_tab_close", "INTEGER");
  addColumnIfNotExists("user_preferences", "hidden_rail_tabs", "TEXT");
  addColumnIfNotExists("user_preferences", "compact_host_view", "INTEGER");
  addColumnIfNotExists("user_preferences", "status_color_scheme", "TEXT");
  addColumnIfNotExists("user_preferences", "custom_themes", "TEXT");
  addColumnIfNotExists("user_preferences", "custom_keybindings", "TEXT");
  addColumnIfNotExists("user_preferences", "terminal_defaults", "TEXT");
  addColumnIfNotExists("user_preferences", "terminal_macros", "TEXT");

  addColumnIfNotExists("users", "is_admin", "INTEGER NOT NULL DEFAULT 0");

  addColumnIfNotExists("users", "is_oidc", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfNotExists("users", "oidc_identifier", "TEXT");
  addColumnIfNotExists("users", "client_id", "TEXT");
  addColumnIfNotExists("users", "client_secret", "TEXT");
  addColumnIfNotExists("users", "issuer_url", "TEXT");
  addColumnIfNotExists("users", "authorization_url", "TEXT");
  addColumnIfNotExists("users", "token_url", "TEXT");

  addColumnIfNotExists("users", "identifier_path", "TEXT");
  addColumnIfNotExists("users", "name_path", "TEXT");
  addColumnIfNotExists("users", "scopes", "TEXT");

  const hadRegisteredAtColumn = (() => {
    try {
      sqlite.prepare(`SELECT "registered_at" FROM users LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  })();
  // SQLite's ALTER TABLE ADD COLUMN rejects non-constant defaults like
  // CURRENT_TIMESTAMP, so the column is added empty and backfilled below.
  addColumnIfNotExists("users", "registered_at", "TEXT");
  if (!hadRegisteredAtColumn) {
    // Pre-existing users are backdated past the 30 day mark so they see the
    // donation modal immediately on upgrade instead of waiting a fresh
    // 30 days as if they had just registered.
    try {
      sqlite.exec(
        `UPDATE users SET registered_at = datetime('now', '-31 days') WHERE registered_at IS NULL`,
      );
    } catch (backfillError) {
      databaseLogger.warn("Failed to backfill users.registered_at", {
        operation: "schema_migration",
        error:
          getErrorMessage(backfillError, String(backfillError)),
      });
    }
  } else {
    try {
      sqlite.exec(
        `UPDATE users SET registered_at = CURRENT_TIMESTAMP WHERE registered_at IS NULL`,
      );
    } catch (backfillError) {
      databaseLogger.warn(
        "Failed to backfill NULL users.registered_at values",
        {
          operation: "schema_migration",
          error:
            getErrorMessage(backfillError, String(backfillError)),
        },
      );
    }
  }
  addColumnIfNotExists(
    "users",
    "donation_modal_dismissed",
    "INTEGER NOT NULL DEFAULT 0",
  );

  addColumnIfNotExists("sessions", "oidc_sub", "TEXT");
  addColumnIfNotExists("sessions", "oidc_sid", "TEXT");
  addColumnIfNotExists("sessions", "sso_provider_id", "INTEGER");

  addColumnIfNotExists("ssh_data", "name", "TEXT");
  addColumnIfNotExists("ssh_data", "folder", "TEXT");
  addColumnIfNotExists("ssh_data", "tags", "TEXT");
  addColumnIfNotExists("ssh_data", "pin", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfNotExists("ssh_data", "sort_order", "INTEGER");
  addColumnIfNotExists("ssh_folders", "sort_order", "INTEGER");
  addColumnIfNotExists(
    "ssh_data",
    "auth_type",
    'TEXT NOT NULL DEFAULT "password"',
  );
  addColumnIfNotExists("ssh_data", "password", "TEXT");
  addColumnIfNotExists("ssh_data", "key", "TEXT");
  addColumnIfNotExists("ssh_data", "key_password", "TEXT");
  addColumnIfNotExists("ssh_data", "key_type", "TEXT");
  addColumnIfNotExists("ssh_data", "jump_hosts", "TEXT");
  addColumnIfNotExists(
    "ssh_data",
    "created_at",
    "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
  );
  addColumnIfNotExists(
    "ssh_data",
    "updated_at",
    "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
  );
  addColumnIfNotExists("ssh_data", "force_keyboard_interactive", "TEXT");
  addColumnIfNotExists(
    "ssh_data",
    "credential_id",
    "INTEGER REFERENCES ssh_credentials(id) ON DELETE SET NULL",
  );
  addColumnIfNotExists(
    "ssh_data",
    "override_credential_username",
    "INTEGER",
  );

  addColumnIfNotExists(
    "ssh_data",
    "status_check_enabled",
    "INTEGER NOT NULL DEFAULT 1",
  );
  addColumnIfNotExists("ssh_data", "status_check_interval", "INTEGER");
  addColumnIfNotExists("ssh_data", "terminal_config", "TEXT");
  addColumnIfNotExists("ssh_data", "quick_actions", "TEXT");

  addColumnIfNotExists("ssh_data", "connection_type", 'TEXT NOT NULL DEFAULT "ssh"');
  addColumnIfNotExists("ssh_data", "domain", "TEXT");
  addColumnIfNotExists("ssh_data", "notes", "TEXT");


  addColumnIfNotExists("ssh_data", "host_key_fingerprint", "TEXT");
  addColumnIfNotExists("ssh_data", "host_key_type", "TEXT");
  addColumnIfNotExists("ssh_data", "host_key_algorithm", "TEXT DEFAULT 'sha256'");
  addColumnIfNotExists("ssh_data", "host_key_first_seen", "TEXT");
  addColumnIfNotExists("ssh_data", "host_key_last_verified", "TEXT");
  addColumnIfNotExists("ssh_data", "host_key_changed_count", "INTEGER DEFAULT 0");


  addColumnIfNotExists("ssh_credentials", "private_key", "TEXT");
  addColumnIfNotExists("ssh_credentials", "public_key", "TEXT");
  addColumnIfNotExists("ssh_credentials", "detected_key_type", "TEXT");

  addColumnIfNotExists("ssh_credentials", "cert_public_key", "TEXT");

  addColumnIfNotExists(
    "ssh_credentials",
    "pin",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfNotExists("ssh_credentials", "sort_order", "INTEGER");

  try {
    const tableInfo = sqlite.prepare("PRAGMA table_info(ssh_credentials)").all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const usernameCol = tableInfo.find((col) => col.name === "username");

    if (usernameCol && usernameCol.notnull === 1) {
      const tempTableName = "ssh_credentials_temp_migration";
      const allColumns = tableInfo.map((col) => `"${col.name}"`).join(", ");

      // Derive the replacement table from the live definition instead of
      // restating it here. The table keeps gaining columns (cert_public_key,
      // pin, sort_order, sync_id, ...), and a second copy of the column list
      // falls behind every time one is added — leaving the copy narrower than
      // the table, so the INSERT below fails and the constraint stays put.
      const createSql = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ssh_credentials'")
        .pluck()
        .get() as string | undefined;

      if (!createSql) {
        throw new Error("ssh_credentials has no stored table definition");
      }

      // Only the table name is rewritten; replace() stops at the first match,
      // and in a CREATE TABLE statement that is the table being defined.
      const renamedSql = createSql.replace("ssh_credentials", tempTableName);
      const tempCreateSql = renamedSql.replace(/(["`[]?username["`\]]?\s+TEXT)\s+NOT\s+NULL/i, "$1");

      if (tempCreateSql === renamedSql) {
        throw new Error("could not derive a nullable-username definition for ssh_credentials");
      }

      // DROP TABLE takes the table's indexes with it, so replay them afterwards.
      const indexDefs = sqlite
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ssh_credentials' AND sql IS NOT NULL",
        )
        .pluck()
        .all() as string[];

      sqlite.exec(`PRAGMA foreign_keys = OFF`);
      sqlite.exec(`
        ${tempCreateSql};

        INSERT INTO ${tempTableName} (${allColumns}) SELECT ${allColumns} FROM ssh_credentials;

        DROP TABLE ssh_credentials;

        ALTER TABLE ${tempTableName} RENAME TO ssh_credentials;
      `);
      for (const indexSql of indexDefs) {
        sqlite.exec(indexSql);
      }
      sqlite.exec(`PRAGMA foreign_keys = ON`);

      databaseLogger.info("Successfully migrated ssh_credentials table to remove username NOT NULL constraint", {
        operation: "schema_migration_username_nullable",
        restoredIndexes: indexDefs.length,
      });
    }
  } catch (migrationError) {
    databaseLogger.warn("Failed to migrate ssh_credentials username column", {
      operation: "schema_migration",
      error: migrationError,
    });
  }

  try {
    const auditLogColumns = sqlite.prepare("PRAGMA table_info(audit_logs)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const auditUserIdCol = auditLogColumns.find((col) => col.name === "user_id");

    if (auditUserIdCol && auditUserIdCol.notnull === 1) {
      const tempTableName = "audit_logs_temp_migration";
      const columns = [
        "id",
        "user_id",
        "username",
        "action",
        "resource_type",
        "resource_id",
        "resource_name",
        "details",
        "ip_address",
        "user_agent",
        "success",
        "error_message",
        "timestamp",
      ].join(", ");

      sqlite.exec(`PRAGMA foreign_keys = OFF`);
      sqlite.exec(`
        CREATE TABLE ${tempTableName} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT,
          username TEXT NOT NULL,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          resource_name TEXT,
          details TEXT,
          ip_address TEXT,
          user_agent TEXT,
          success INTEGER NOT NULL,
          error_message TEXT,
          timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
        );

        INSERT INTO ${tempTableName} (${columns}) SELECT ${columns} FROM audit_logs;

        DROP TABLE audit_logs;

        ALTER TABLE ${tempTableName} RENAME TO audit_logs;
      `);
      sqlite.exec(`PRAGMA foreign_keys = ON`);

      databaseLogger.info("Successfully migrated audit_logs table to remove user_id NOT NULL constraint", {
        operation: "schema_migration_audit_user_id_nullable",
      });
    }
  } catch (migrationError) {
    databaseLogger.warn("Failed to migrate audit_logs user_id column", {
      operation: "schema_migration",
      error: migrationError,
    });
  }


  try {
    sqlite.prepare("SELECT credential_id FROM ssh_folders LIMIT 1").get();
  } catch {
    try {
      sqlite.exec("ALTER TABLE ssh_folders ADD COLUMN credential_id INTEGER REFERENCES ssh_credentials(id) ON DELETE SET NULL");
    } catch (alterError) {
      databaseLogger.warn("Failed to add credential_id column to ssh_folders", {
        operation: "schema_migration",
        error: alterError,
      });
    }
  }

  try {
    sqlite.prepare("SELECT sudo_password FROM ssh_data LIMIT 1").get();
  } catch {
    try {
      sqlite.exec("ALTER TABLE ssh_data ADD COLUMN sudo_password TEXT");
    } catch (alterError) {
      databaseLogger.warn("Failed to add sudo_password column", {
        operation: "schema_migration",
        error: alterError,
      });
    }
  }

  const sshDataMigrations: Array<{ column: string; sql: string }> = [
    { column: "connection_type", sql: "ALTER TABLE ssh_data ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'ssh'" },
    { column: "credential_id", sql: "ALTER TABLE ssh_data ADD COLUMN credential_id INTEGER" },
    { column: "override_credential_username", sql: "ALTER TABLE ssh_data ADD COLUMN override_credential_username INTEGER" },
    { column: "jump_hosts", sql: "ALTER TABLE ssh_data ADD COLUMN jump_hosts TEXT" },
    { column: "quick_actions", sql: "ALTER TABLE ssh_data ADD COLUMN quick_actions TEXT" },
    { column: "host_key_fingerprint", sql: "ALTER TABLE ssh_data ADD COLUMN host_key_fingerprint TEXT" },
    { column: "host_key_type", sql: "ALTER TABLE ssh_data ADD COLUMN host_key_type TEXT" },
    { column: "host_key_algorithm", sql: "ALTER TABLE ssh_data ADD COLUMN host_key_algorithm TEXT NOT NULL DEFAULT 'sha256'" },
    { column: "host_key_first_seen", sql: "ALTER TABLE ssh_data ADD COLUMN host_key_first_seen TEXT" },
    { column: "host_key_last_verified", sql: "ALTER TABLE ssh_data ADD COLUMN host_key_last_verified TEXT" },
    { column: "host_key_changed_count", sql: "ALTER TABLE ssh_data ADD COLUMN host_key_changed_count INTEGER NOT NULL DEFAULT 0" },
    { column: "port_knock_sequence", sql: "ALTER TABLE ssh_data ADD COLUMN port_knock_sequence TEXT" },
    { column: "enable_ssh", sql: "ALTER TABLE ssh_data ADD COLUMN enable_ssh INTEGER NOT NULL DEFAULT 1" },
    { column: "ssh_port", sql: "ALTER TABLE ssh_data ADD COLUMN ssh_port INTEGER DEFAULT 22" },
    { column: "parent_host_id", sql: "ALTER TABLE ssh_data ADD COLUMN parent_host_id INTEGER REFERENCES ssh_data(id) ON DELETE SET NULL" },
  ];

  for (const migration of sshDataMigrations) {
    try {
      sqlite.prepare(`SELECT ${migration.column} FROM ssh_data LIMIT 1`).get();
    } catch {
      try {
        sqlite.exec(migration.sql);
      } catch (alterError) {
        databaseLogger.warn(`Failed to add ${migration.column} column`, {
          operation: "schema_migration",
          error: alterError,
        });
      }
    }
  }


  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS host_protocol_auth (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        protocol TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'direct',
        credential_id INTEGER,
        username TEXT,
        password TEXT,
        fields TEXT,
        secret_fields TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (host_id) REFERENCES ssh_data (id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (credential_id) REFERENCES ssh_credentials (id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_host_protocol_auth_host_protocol ON host_protocol_auth (host_id, protocol);
      CREATE INDEX IF NOT EXISTS idx_host_protocol_auth_user ON host_protocol_auth (user_id);
      CREATE INDEX IF NOT EXISTS idx_host_protocol_auth_credential ON host_protocol_auth (credential_id);
    `);
  } catch (createError) {
    databaseLogger.warn("Failed to create host_protocol_auth table", {
      operation: "schema_migration",
      error: createError,
    });
  }

  addColumnIfNotExists("ssh_data", "default_overrides", "TEXT");
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS host_defaults (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        user_id TEXT,
        folder_id INTEGER,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (folder_id) REFERENCES ssh_folders (id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_host_defaults_scope_key ON host_defaults (scope_key, namespace, key);
      CREATE INDEX IF NOT EXISTS idx_host_defaults_user ON host_defaults (user_id);
      CREATE INDEX IF NOT EXISTS idx_host_defaults_folder ON host_defaults (folder_id);
    `);
  } catch (createError) {
    databaseLogger.warn("Failed to create host_defaults table", {
      operation: "schema_migration",
      error: createError,
    });
  }


  addColumnIfNotExists("users", "sso_provider_id", "INTEGER");

  try {
    const usersTableInfo = sqlite.prepare("PRAGMA table_info(users)").all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const legacyNotNullColumns = new Set([
      "client_id",
      "client_secret",
      "issuer_url",
      "authorization_url",
      "token_url",
      "identifier_path",
      "name_path",
      "scopes",
    ]);
    const hasStaleNotNull = usersTableInfo.some(
      (col) => legacyNotNullColumns.has(col.name) && col.notnull === 1,
    );

    if (hasStaleNotNull) {
      const tempTableName = "users_temp_migration";
      const columnDefs = usersTableInfo
        .map((col) => {
          const parts = [`"${col.name}"`, col.type || "TEXT"];
          if (col.pk === 1) parts.push("PRIMARY KEY");
          if (col.notnull === 1 && !legacyNotNullColumns.has(col.name)) {
            parts.push("NOT NULL");
          }
          if (col.dflt_value !== null) {
            parts.push(`DEFAULT ${col.dflt_value}`);
          }
          return parts.join(" ");
        })
        .join(",\n          ");
      const allColumns = usersTableInfo.map((col) => `"${col.name}"`).join(", ");

      sqlite.exec(`PRAGMA foreign_keys = OFF`);
      sqlite.exec(`
        CREATE TABLE ${tempTableName} (
          ${columnDefs}
        );

        INSERT INTO ${tempTableName} SELECT ${allColumns} FROM users;

        DROP TABLE users;

        ALTER TABLE ${tempTableName} RENAME TO users;
      `);
      sqlite.exec(`PRAGMA foreign_keys = ON`);

      databaseLogger.info(
        "Successfully migrated users table to remove legacy OIDC NOT NULL constraints",
        {
          operation: "schema_migration_users_oidc_nullable",
        },
      );
    }
  } catch (migrationError) {
    databaseLogger.warn("Failed to migrate users table legacy OIDC columns", {
      operation: "schema_migration",
      error: migrationError,
    });
  }

  // --- alerts begin ---
  // alert_rules, alert_rule_channels and alert_firings were only ever created
  // here, never declared in schema.ts, so they never existed on Postgres or
  // MySQL at all. Automations replaced them; drop the SQLite leftovers.
  for (const table of [
    "alert_firings",
    "alert_rule_channels",
    "alert_rules",
  ]) {
    try {
      sqlite.exec(`DROP TABLE IF EXISTS ${table};`);
    } catch (dropError) {
      databaseLogger.warn(`Failed to drop legacy ${table} table`, {
        operation: "schema_migration",
        error: dropError,
      });
    }
  }
  // --- alerts end ---


  // Plugin runtime columns introduced after the original schema.
  addColumnIfNotExists("plugins", "last_error", "TEXT");
  addColumnIfNotExists(
    "plugin_permission_grants",
    "source",
    "TEXT NOT NULL DEFAULT 'admin'",
  );
  relaxPluginGrantGrantedBy();
  addColumnIfNotExists("ssh_data", "ssh_options", "TEXT");

  // Old desktop-sync tables and indexes are inert in NodeShell v0.1. Remove
  // the active indexing/table overhead while leaving legacy row columns alone
  // so upgrades never depend on SQLite DROP COLUMN support.
  try {
    sqlite.exec(`
      DROP INDEX IF EXISTS idx_ssh_data_sync_id;
      DROP INDEX IF EXISTS idx_ssh_credentials_sync_id;
      DROP INDEX IF EXISTS idx_ssh_folders_sync_id;
      DROP TABLE IF EXISTS sync_tombstones;
      DROP TABLE IF EXISTS sync_conflicts;
      DROP TABLE IF EXISTS sync_records;
      DROP TABLE IF EXISTS sync_link;
    `);
  } catch (dropError) {
    databaseLogger.warn("Failed to remove legacy desktop sync storage", {
      operation: "schema_migration",
      error: dropError,
    });
  }

  // Audit trails and session recordings used to be deleted along with the user
  // they referenced, which defeats the point of keeping them.
  migrateAuditRetention(sqlite);

  // Runs last so every table and column added above already exists.
  createPerformanceIndexes(sqlite);

  databaseLogger.success("Schema migration completed", {
    operation: "schema_migration",
  });
};

// A trivial telemetry write forces `serialize()` to rewrite every free page
// along with the live ones, so a database that has accumulated a large
// freelist (from years of unbounded metrics/audit growth before retention
// pruning existed) turns every future save into a multi-megabyte rewrite.
// Reclaiming that space once at startup keeps steady-state saves cheap.
const VACUUM_FREELIST_COUNT_THRESHOLD = 2000;
const VACUUM_FREELIST_RATIO_THRESHOLD = 0.5;

function vacuumIfFreelistBloated(): void {
  try {
    const pageCount = sqlite.pragma("page_count", { simple: true }) as number;
    const freelistCount = sqlite.pragma("freelist_count", {
      simple: true,
    }) as number;
    if (pageCount <= 0) return;

    const freelistRatio = freelistCount / pageCount;
    if (
      freelistCount < VACUUM_FREELIST_COUNT_THRESHOLD ||
      freelistRatio < VACUUM_FREELIST_RATIO_THRESHOLD
    ) {
      return;
    }

    databaseLogger.info("Reclaiming bloated SQLite freelist on startup", {
      operation: "db_startup_vacuum",
      pageCount,
      freelistCount,
      freelistRatio,
    });
    sqlite.exec("VACUUM");
  } catch (error) {
    databaseLogger.warn("Failed to vacuum database on startup", {
      operation: "db_startup_vacuum_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function saveMemoryDatabaseToFile(): Promise<void> {
  if (!memoryDatabase) return;

  try {
    const buffer = memoryDatabase.serialize();

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    try {
      memoryDatabase
        .prepare("SELECT COUNT(*) as count FROM sessions")
        .get() as { count: number };
    } catch {
      // expected - sessions table may not exist yet
    }

    if (enableFileEncryption) {
      await DatabaseFileEncryption.encryptDatabaseFromBuffer(
        buffer,
        encryptedDbPath,
      );
    } else {
      fs.writeFileSync(dbPath, buffer);
    }

    DatabaseSaveTrigger.markClean();
  } catch (error) {
    databaseLogger.error("Failed to save in-memory database", error, {
      operation: "memory_db_save_failed",
      enableFileEncryption,
    });
  }
}

async function handlePostInitFileEncryption() {
  try {
    if (memoryDatabase) {
      DatabaseSaveTrigger.initialize(saveMemoryDatabaseToFile);

      if (enableFileEncryption) {
        await saveMemoryDatabaseToFile();
      }

      setInterval(() => {
        if (DatabaseSaveTrigger.isDirty) {
          saveMemoryDatabaseToFile();
        }
      }, 5 * 60 * 1000);
    }

    if (!enableFileEncryption) return;

    try {
      const migration = new DatabaseMigration(dataDir);
      migration.cleanupOldBackups();
    } catch (cleanupError) {
      databaseLogger.warn("Failed to cleanup old migration files", {
        operation: "migration_cleanup_startup_failed",
        error:
          getErrorMessage(cleanupError),
      });
    }
  } catch (error) {
    databaseLogger.error(
      "Failed to handle database file encryption setup",
      error,
      {
        operation: "db_encrypt_setup_failed",
      },
    );
  }
}

async function initializeDatabase(): Promise<void> {
  await initializeCompleteDatabase();
  await handlePostInitFileEncryption();
}

export { initializeDatabase };

async function cleanupDatabase() {
  if (memoryDatabase) {
    try {
      await saveMemoryDatabaseToFile();
    } catch (error) {
      databaseLogger.error(
        "Failed to save in-memory database before shutdown",
        error,
        {
          operation: "shutdown_save_failed",
        },
      );
    }
  }

  try {
    if (sqlite) {
      sqlite.close();
    }
  } catch (error) {
    databaseLogger.warn("Error closing database connection", {
      operation: "db_close_error",
      error: getErrorMessage(error),
    });
  }

  try {
    const tempDir = path.join(dataDir, ".temp");
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(tempDir, file));
        } catch {
          // expected - file cleanup best effort
        }
      }

      try {
        fs.rmdirSync(tempDir);
      } catch {
        // expected - dir cleanup best effort
      }
    }
  } catch {
    // expected - temp dir cleanup best effort
  }
}

process.on("exit", () => {
  if (sqlite) {
    try {
      sqlite.close();
    } catch {
      // expected - database may already be closed
    }
  }
});

process.on("SIGINT", async () => {
  databaseLogger.info("Received SIGINT, cleaning up...", {
    operation: "shutdown",
  });
  await cleanupDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  databaseLogger.info("Received SIGTERM, cleaning up...", {
    operation: "shutdown",
  });
  await cleanupDatabase();
  process.exit(0);
});

let db: PortableDatabase;

export function getDb(): PortableDatabase {
  if (!db) {
    throw new Error(
      "Database not initialized. Ensure initializeDatabase() is called before accessing db.",
    );
  }
  return db;
}

export function getSqlite(): Database.Database {
  if (!sqlite) {
    throw new Error(
      "SQLite not initialized. Ensure initializeDatabase() is called before accessing sqlite.",
    );
  }
  return sqlite;
}



export { saveMemoryDatabaseToFile };

export { DatabaseSaveTrigger };
