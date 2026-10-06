/**
 * NodeShell v0.1 intentionally supports SQLite only.
 *
 * The database lives in memory while the service runs and is serialized to
 * the encrypted data file after writes. Keeping a single engine makes backup,
 * recovery and secret-handling behavior deterministic.
 */
export type DatabaseDialect = "sqlite";

export function resolveDatabaseDialect(): DatabaseDialect {
  return "sqlite";
}

export function needsExplicitPersist(
  _dialect: DatabaseDialect = "sqlite",
): boolean {
  return true;
}
