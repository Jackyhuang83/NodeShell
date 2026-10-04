import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { SQL } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import * as schema from "../../../database/db/schema.js";
import type { DatabaseContext } from "../../../database/repositories/database-context.js";
import type { DatabaseDialect } from "../../../database/db/dialect.js";

/** NodeShell v0.1 repository tests run against the supported SQLite engine. */
export function testDialect(
  _env: NodeJS.ProcessEnv = process.env,
): DatabaseDialect {
  return "sqlite";
}

export class TestSqliteDatabase {
  private sqlite: Database.Database | null = null;
  private context: DatabaseContext | null = null;

  constructor(_dialect: DatabaseDialect = testDialect()) {}

  async connect(): Promise<DatabaseContext> {
    if (this.context) return this.context;

    this.sqlite = new Database(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(sqliteSchemaSql());
    this.context = {
      dialect: "sqlite",
      drizzle: drizzle(this.sqlite, { schema }),
    };

    return this.context;
  }

  exec(statements: string): void {
    if (!this.sqlite) {
      throw new Error("connect() must be called before exec()");
    }
    this.sqlite.exec(statements);
  }

  async query<T = Record<string, unknown>>(statement: SQL): Promise<T[]> {
    if (!this.context) {
      throw new Error("connect() must be called before query()");
    }
    const db = this.context.drizzle as unknown as {
      all: (statement: SQL) => Promise<T[]> | T[];
    };
    return (await db.all(statement)) as T[];
  }

  async run(statement: SQL): Promise<void> {
    if (!this.context) {
      throw new Error("connect() must be called before run()");
    }
    const db = this.context.drizzle as unknown as {
      run: (statement: SQL) => unknown;
    };
    db.run(statement);
  }

  async close(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }
    this.context = null;
  }
}

let cachedSqliteSchema: string | null = null;

function sqliteSchemaSql(): string {
  if (cachedSqliteSchema) return cachedSqliteSchema;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, "../../../../..", "drizzle", "sqlite");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No SQLite migration found in ${dir}`);
  }

  cachedSqliteSchema = files
    .map((file) =>
      fs
        .readFileSync(path.join(dir, file), "utf8")
        .split("--> statement-breakpoint")
        .join("\n"),
    )
    .join("\n");

  return cachedSqliteSchema;
}
