import { describe, expect, it } from "vitest";
import { CURRENT_FORMAT_VERSION } from "./project.js";
import { migrateMapTo, migrateTo, migrations } from "./migrations.js";
import type { Migration } from "./migrations.js";

// 連鎖の仕組みは、テスト用の v1→v3 で検証する（実マイグレーションは下の "registered migrations"）。
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
  it("registered migrations are contiguous and end at CURRENT_FORMAT_VERSION", () => {
    migrations.forEach((m, i) => {
      expect(m.to).toBe(m.from + 1);
      expect(m.from).toBe(migrations[0]!.from + i);
    });
    expect(migrations.at(-1)?.to).toBe(CURRENT_FORMAT_VERSION);
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

describe("registered migrations", () => {
  const v1 = { formatVersion: 1, meta: {}, system: { startMap: "m", terms: {} }, other: 1 };

  it("v1 → v2 adds system.plugins as an empty list, keeping everything else", () => {
    expect(migrateTo(v1, 2)).toEqual({ ok: true, value: { ...v1, formatVersion: 2, system: { ...v1.system, plugins: [] } } });
  });

  it("v1 → v2 keeps plugins that are already there, and leaves malformed input for the schema to reject", () => {
    const withPlugins = { ...v1, system: { ...v1.system, plugins: [{ name: "x", version: "1", params: {} }] } };
    expect(migrateTo(withPlugins, 2)).toMatchObject({ ok: true, value: { system: { plugins: [{ name: "x" }] } } });
    expect(migrateTo({ formatVersion: 1, system: "broken" }, 2)).toEqual({ ok: true, value: { formatVersion: 2, system: "broken" } });
    expect(migrateTo({ formatVersion: 1 }, 2)).toEqual({ ok: true, value: { formatVersion: 2 } });
  });

  it("v1 → v2 does not change maps; v2 data is untouched", () => {
    expect(migrateMapTo({ a: 1 }, 1, 2)).toEqual({ ok: true, value: { a: 1 } });
    expect(migrateTo({ formatVersion: 2, system: {} }, 2)).toEqual({ ok: true, value: { formatVersion: 2, system: {} } });
  });
});
