import { and, eq, like, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { hosts, sshCredentials, sshFolders } from "../db/schema.js";
import type { DatabaseContext } from "./database-context.js";
import { rowsAffected } from "./mutation-result.js";
import { insertReturning, updateReturning } from "./returning.js";

export type HostFolderRecord = typeof sshFolders.$inferSelect;
export type HostFolderHostRecord = typeof hosts.$inferSelect;

export interface RenameFolderResult {
  updatedHosts: number;
  updatedCredentials: number;
}

export class HostFolderRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async renameFolder(
    userId: string,
    oldName: string,
    newName: string,
    now = new Date().toISOString(),
  ): Promise<RenameFolderResult> {
    const textType = "text";
    const oldPrefix = `${oldName} / `;
    const newPrefix = `${newName} / `;
    const childLike = `${oldPrefix}%`;
    // CONCAT, not `||`: MySQL reads `||` as logical OR unless the server runs
    // with PIPES_AS_CONCAT, so the child paths would have been rewritten to 0.
    // No error, just wrong folder names. CONCAT and SUBSTR mean the same thing
    // on all three engines.
    //
    // The prefix is inlined rather than bound: CONCAT is variadic, so Postgres
    // cannot infer a parameter's type from its position and rejects the
    // statement with 42P18 before it runs. The value is a folder name the
    // caller supplied, so it goes through a bound placeholder in a plain
    // concatenation instead of sql.raw.
    const renameExpr = (col: SQLiteColumn) =>
      sql`CASE WHEN ${col} = ${oldName} THEN ${newName} ELSE CONCAT(CAST(${newPrefix} AS ${sql.raw(textType)}), SUBSTR(${col}, ${sql.raw(String(oldPrefix.length + 1))})) END`;
    const folderMatch = (col: SQLiteColumn) =>
      or(eq(col, oldName), like(col, childLike));

    const updatedHosts = await this.context.drizzle
      .update(hosts)
      .set({ folder: renameExpr(hosts.folder), updatedAt: now })
      .where(and(eq(hosts.userId, userId), folderMatch(hosts.folder)));

    const updatedCredentials = await this.context.drizzle
      .update(sshCredentials)
      .set({ folder: renameExpr(sshCredentials.folder), updatedAt: now })
      .where(
        and(
          eq(sshCredentials.userId, userId),
          folderMatch(sshCredentials.folder),
        ),
      );

    await this.context.drizzle
      .update(sshFolders)
      .set({ name: renameExpr(sshFolders.name), updatedAt: now })
      .where(and(eq(sshFolders.userId, userId), folderMatch(sshFolders.name)));

    await this.afterWrite();
    return {
      updatedHosts: rowsAffected(updatedHosts),
      updatedCredentials: rowsAffected(updatedCredentials),
    };
  }

  async listFolders(userId: string): Promise<HostFolderRecord[]> {
    return this.context.drizzle
      .select()
      .from(sshFolders)
      .where(eq(sshFolders.userId, userId));
  }

  async upsertMetadata(
    userId: string,
    name: string,
    color: string | null | undefined,
    icon: string | null | undefined,
    credentialId?: number | null,
    now = new Date().toISOString(),
  ): Promise<{ folder: HostFolderRecord; created: boolean }> {
    const existing = await this.findFolder(userId, name);
    if (existing) {
      const [updated] = await updateReturning(
        this.context,
        sshFolders,
        {
          color,
          icon,
          credentialId:
            credentialId === undefined ? existing.credentialId : credentialId,
          updatedAt: now,
        },
        and(eq(sshFolders.userId, userId), eq(sshFolders.name, name)),
      );

      await this.afterWrite();
      return { folder: updated, created: false };
    }

    const [created] = await insertReturning(this.context, sshFolders, {
      userId,
      name,
      color,
      icon,
      credentialId: credentialId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    await this.afterWrite();
    return { folder: created, created: true };
  }

  /**
   * Sets a distinct manual sortOrder per sibling folder (drag-to-reorder).
   * Folders with no existing sshFolders row are created first (matching the
   * empty-folder-persists behavior elsewhere) so the order survives even for
   * folders that only ever existed implicitly via host paths.
   */
  async reorderFolders(
    userId: string,
    positions: { name: string; sortOrder: number }[],
    now = new Date().toISOString(),
  ): Promise<number> {
    if (positions.length === 0) return 0;

    let affected: number;
    if (this.context.dialect === "sqlite") {
      affected = this.context.drizzle.transaction((tx) => {
        let count = 0;
        for (const { name, sortOrder } of positions) {
          const result = tx
            .update(sshFolders)
            .set({ sortOrder, updatedAt: now })
            .where(
              and(eq(sshFolders.userId, userId), eq(sshFolders.name, name)),
            )
            .run();
          if (rowsAffected(result) > 0) {
            count += rowsAffected(result);
            continue;
          }
          tx.insert(sshFolders)
            .values({
              userId,
              name,
              sortOrder,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          count += 1;
        }
        return count;
      });
    } else {
      affected = await this.context.drizzle.transaction(async (tx) => {
        let count = 0;
        for (const { name, sortOrder } of positions) {
          const result = await tx
            .update(sshFolders)
            .set({ sortOrder, updatedAt: now })
            .where(
              and(eq(sshFolders.userId, userId), eq(sshFolders.name, name)),
            );
          if (rowsAffected(result) > 0) {
            count += rowsAffected(result);
            continue;
          }
          await tx.insert(sshFolders).values({
            userId,
            name,
            sortOrder,
            createdAt: now,
            updatedAt: now,
          });
          count += 1;
        }
        return count;
      });
    }

    if (affected > 0) {
      await this.afterWrite();
    }

    return affected;
  }

  async listHostsInFolder(
    userId: string,
    folderName: string,
  ): Promise<HostFolderHostRecord[]> {
    const folderMatch = (col: SQLiteColumn) =>
      or(eq(col, folderName), like(col, `${folderName} / %`));

    return this.context.drizzle
      .select()
      .from(hosts)
      .where(and(eq(hosts.userId, userId), folderMatch(hosts.folder)));
  }

  async deleteHostsAndFolderRecords(
    userId: string,
    folderName: string,
  ): Promise<void> {
    const folderMatch = (col: SQLiteColumn) =>
      or(eq(col, folderName), like(col, `${folderName} / %`));

    await this.context.drizzle
      .delete(hosts)
      .where(and(eq(hosts.userId, userId), folderMatch(hosts.folder)));

    await this.context.drizzle
      .delete(sshFolders)
      .where(and(eq(sshFolders.userId, userId), folderMatch(sshFolders.name)));

    await this.afterWrite();
  }

  async deleteByUserId(userId: string): Promise<number> {
    const result = await this.context.drizzle
      .delete(sshFolders)
      .where(eq(sshFolders.userId, userId));

    if (rowsAffected(result) > 0) {
      await this.afterWrite();
    }

    return rowsAffected(result);
  }

  private async findFolder(
    userId: string,
    name: string,
  ): Promise<HostFolderRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(sshFolders)
      .where(and(eq(sshFolders.userId, userId), eq(sshFolders.name, name)))
      .limit(1);

    return rows[0] ?? null;
  }

  private async afterWrite(): Promise<void> {
    await this.onWrite?.();
  }
}
