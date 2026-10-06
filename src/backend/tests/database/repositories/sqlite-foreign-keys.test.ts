import { afterEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => ({
  getCurrentRepositorySqlite: vi.fn(),
}));

vi.mock("../../../database/repositories/factory.js", () => factory);

import {
  withCurrentSqliteForeignKeysDisabled,
  withSqliteForeignKeysDisabled,
} from "../../../database/repositories/sqlite-foreign-keys.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("withSqliteForeignKeysDisabled", () => {
  it("restores foreign keys after an import", async () => {
    const sqlite = { exec: vi.fn() };

    await expect(
      withSqliteForeignKeysDisabled(sqlite, async () => "imported"),
    ).resolves.toBe("imported");

    expect(sqlite.exec.mock.calls).toEqual([
      ["PRAGMA foreign_keys = OFF"],
      ["PRAGMA foreign_keys = ON"],
    ]);
  });

  it("restores foreign keys even when the import fails", async () => {
    const sqlite = { exec: vi.fn() };

    await expect(
      withSqliteForeignKeysDisabled(sqlite, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    expect(sqlite.exec.mock.calls).toEqual([
      ["PRAGMA foreign_keys = OFF"],
      ["PRAGMA foreign_keys = ON"],
    ]);
  });
});

describe("withCurrentSqliteForeignKeysDisabled", () => {
  it("uses NodeShell's current SQLite connection", async () => {
    const sqlite = { exec: vi.fn() };
    factory.getCurrentRepositorySqlite.mockReturnValue(sqlite);
    const operation = vi.fn().mockResolvedValue("imported");

    await expect(
      withCurrentSqliteForeignKeysDisabled(operation),
    ).resolves.toBe("imported");

    expect(factory.getCurrentRepositorySqlite).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
    expect(sqlite.exec.mock.calls).toEqual([
      ["PRAGMA foreign_keys = OFF"],
      ["PRAGMA foreign_keys = ON"],
    ]);
  });
});
