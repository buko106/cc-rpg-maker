import { describe, expect, it } from "vitest";
import { migrateMapTo, migrateTo, migrations } from "./migrations.js";
import type { Migration } from "./migrations.js";

// 実マイグレーションは v1 が最初なので存在しない。連鎖の仕組みを、テスト用の v1→v3 で検証する。
const fake: Migration[] = [
  {
    from: 1,
    to: 2,
    migrateProject: (p) => ({ ...(p as object), renamed: (p as { old: string }).old }),
    migrateMap: (m) => ({ ...(m as object), step: "1to2" }),
  },
  {
    from: 2,
    to: 3,
    migrateProject: (p) => ({ ...(p as object), addedInV3: true }),
    migrateMap: (m) => ({ ...(m as object), step: `${(m as { step: string }).step}+2to3` }),
  },
];

describe("migrations", () => {
  it("has none registered yet, and CURRENT versions are contiguous when added", () => {
    migrations.forEach((m, i) => {
      expect(m.to).toBe(m.from + 1);
      expect(m.from).toBe(migrations[0]!.from + i);
    });
  });

  it("applies migrations in order and sets formatVersion to the target", () => {
    const r = migrateTo({ formatVersion: 1, old: "x" }, 3, fake);
    expect(r).toEqual({ ok: true, value: { formatVersion: 3, old: "x", renamed: "x", addedInV3: true } });
  });

  it("starts from the data's own version", () => {
    expect(migrateTo({ formatVersion: 2 }, 3, fake)).toEqual({ ok: true, value: { formatVersion: 3, addedInV3: true } });
  });

  it("is the identity when already at the target", () => {
    expect(migrateTo({ formatVersion: 3, a: 1 }, 3, fake)).toEqual({ ok: true, value: { formatVersion: 3, a: 1 } });
  });

  it("fails when a step is missing", () => {
    expect(migrateTo({ formatVersion: 1 }, 5, fake)).toMatchObject({ ok: false, error: { kind: "migration" } });
  });

  it("does not support downgrades", () => {
    expect(migrateTo({ formatVersion: 3 }, 1, fake)).toMatchObject({ ok: false, error: { kind: "migration" } });
  });

  it("rejects input without an integer formatVersion", () => {
    for (const bad of [null, [], {}, { formatVersion: "1" }, { formatVersion: 1.2 }]) {
      expect(migrateTo(bad, 3, fake)).toMatchObject({ ok: false, error: { kind: "invalid" } });
    }
  });

  it("migrates maps with migrateMap", () => {
    expect(migrateMapTo({}, 1, 3, fake)).toEqual({ ok: true, value: { step: "1to2+2to3" } });
  });
});
