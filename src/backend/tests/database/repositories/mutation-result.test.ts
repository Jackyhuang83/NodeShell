import { describe, expect, it } from "vitest";
import {
  insertedId,
  rowsAffected,
  supportsReturning,
} from "../../../database/repositories/mutation-result.js";

describe("rowsAffected", () => {
  it("counts returning rows", () => {
    expect(rowsAffected([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe(3);
    expect(rowsAffected([])).toBe(0);
  });

  it("reads changes from better-sqlite3 writes", () => {
    expect(rowsAffected({ changes: 1, lastInsertRowid: 7 })).toBe(1);
    expect(rowsAffected({ changes: 0, lastInsertRowid: 7 })).toBe(0);
  });

  it("reports zero for an unknown shape", () => {
    expect(rowsAffected(undefined)).toBe(0);
    expect(rowsAffected(null)).toBe(0);
    expect(rowsAffected({})).toBe(0);
  });
});

describe("insertedId", () => {
  it("reads ids from returning rows", () => {
    expect(insertedId([{ id: 42 }])).toBe(42);
  });

  it("reads better-sqlite3 lastInsertRowid", () => {
    expect(insertedId({ changes: 1, lastInsertRowid: 9 })).toBe(9);
    expect(insertedId({ changes: 1, lastInsertRowid: 9n })).toBe(9);
    expect(insertedId({ changes: 1, lastInsertRowid: 0 })).toBeNull();
  });

  it("returns null when no numeric id is available", () => {
    expect(insertedId([])).toBeNull();
    expect(insertedId({})).toBeNull();
    expect(insertedId([{ id: "u-1" }])).toBeNull();
  });
});

describe("supportsReturning", () => {
  it("is enabled for NodeShell's SQLite database", () => {
    expect(supportsReturning("sqlite")).toBe(true);
  });
});
