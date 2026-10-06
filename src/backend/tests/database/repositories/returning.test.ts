import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  deleteReturning,
  updateReturning,
} from "../../../database/repositories/returning.js";
import type { DatabaseContext } from "../../../database/repositories/database-context.js";

function recordingContext() {
  const calls: string[] = [];
  const rows = [{ id: 1, name: "row" }];

  const chain = (label: string, result: unknown) => {
    calls.push(label);
    const thenable = {
      set: () => thenable,
      where: () => thenable,
      returning: () => Promise.resolve(result),
      then: (resolve: (value: unknown) => void) =>
        Promise.resolve(result).then(resolve),
    };
    return thenable;
  };

  const db = {
    update: () => chain("update", rows),
    delete: () => chain("delete", rows),
  };

  return {
    context: { dialect: "sqlite", drizzle: db } as unknown as DatabaseContext,
    calls,
  };
}

const where = sql`id = 1`;

describe("SQLite returning helpers", () => {
  it("updates and returns rows in one statement", async () => {
    const { context, calls } = recordingContext();
    const rows = await updateReturning(context, {} as never, {}, where);
    expect(rows).toHaveLength(1);
    expect(calls).toEqual(["update"]);
  });

  it("deletes and returns rows in one statement", async () => {
    const { context, calls } = recordingContext();
    const rows = await deleteReturning(context, {} as never, where);
    expect(rows).toHaveLength(1);
    expect(calls).toEqual(["delete"]);
  });
});
