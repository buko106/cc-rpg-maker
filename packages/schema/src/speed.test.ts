import { loadRawProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { MapDataSchema, parseMapData, parseProject, serializeMapData, serializeProject, tilesetSchema } from "./index.js";

// 歩く速さの設定（01）：どれも省略可で、読み書きして変わらない

const tileset = { id: "ts", name: "砂", passage: [15, 15] };

describe("Tileset.terrain（足元のタイルによる速さ）", () => {
  it("タイル番号（1 以上の整数の文字列）をキーに、speed（−5〜5 の整数）と noDash を持てる", () => {
    expect(tilesetSchema.safeParse({ ...tileset, terrain: { "1": { speed: -1 }, "12": { noDash: true }, "3": { speed: 2, noDash: true }, "4": {} } }).success).toBe(true);
    expect(tilesetSchema.safeParse(tileset).success).toBe(true); // 省略可
  });

  it("タイル番号でないキー・範囲外や小数の増減・未知の項目は受け付けない", () => {
    for (const terrain of [{ "0": { speed: -1 } }, { "-1": {} }, { a: {} }, { "1.5": {} }, { "01": {} }, { "1": { speed: 6 } }, { "1": { speed: -6 } }, { "1": { speed: 0.5 } }, { "1": { slow: true } }]) {
      expect(tilesetSchema.safeParse({ ...tileset, terrain }).success, JSON.stringify(terrain)).toBe(false);
    }
  });
});

describe("MapData.walkSpeed / noDash", () => {
  const base = () => structuredClone(loadRawProject("minimal").maps["map_start"]) as Record<string, unknown>;

  it("walkSpeed は 1〜6 の整数、noDash は真偽値。省略できる", () => {
    expect(MapDataSchema.safeParse({ ...base(), walkSpeed: 3, noDash: true }).success).toBe(true);
    expect(MapDataSchema.safeParse(base()).success).toBe(true);
    for (const walkSpeed of [0, 7, 2.5, "4"]) expect(MapDataSchema.safeParse({ ...base(), walkSpeed }).success, String(walkSpeed)).toBe(false);
    expect(MapDataSchema.safeParse({ ...base(), noDash: "yes" }).success).toBe(false);
  });

  it("書き出して読み直しても同じ", () => {
    const parsed = parseMapData({ ...base(), walkSpeed: 2, noDash: true }, 1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const again = parseMapData(JSON.parse(JSON.stringify(serializeMapData(parsed.value))), 1);
    expect(again.ok && again.value).toEqual(parsed.value);
  });
});

describe("system.walkSpeed / dash / speedRules", () => {
  const raw = () => structuredClone(loadRawProject("minimal").project) as { system: Record<string, unknown> };
  const withSystem = (extra: Record<string, unknown>) => {
    const p = raw();
    p.system = { ...p.system, ...extra };
    return parseProject(p);
  };

  it("読み書きして変わらない（走る機能は空のオブジェクトで有効）", () => {
    const parsed = withSystem({ walkSpeed: 5, dash: {}, speedRules: [{ when: [{ kind: "switch", id: "hungry", value: true }], speed: -1, noDash: true }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const again = parseProject(JSON.parse(JSON.stringify(serializeProject(parsed.value))));
    expect(again.ok && again.value).toEqual(parsed.value);
    expect(parsed.value.system.dash).toEqual({});
  });

  it("範囲外の値は受け付けない", () => {
    expect(withSystem({ dash: { bonus: 3 } }).ok).toBe(true);
    for (const extra of [{ walkSpeed: 0 }, { walkSpeed: 7 }, { dash: { bonus: 0 } }, { dash: { bonus: 4 } }, { dash: true }, { speedRules: [{ when: [], speed: 9 }] }, { speedRules: [{ speed: 1 }] }]) {
      expect(withSystem(extra).ok, JSON.stringify(extra)).toBe(false);
    }
  });
});
