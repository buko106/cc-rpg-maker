import fc from "fast-check";
import { listProjectFixtures, loadRawProject, mapDataArb, projectArb } from "@rpg/test-utils";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CURRENT_FORMAT_VERSION,
  MapDataSchema,
  migrateTo,
  parseMapData,
  parseProject,
  serializeMapData,
  serializeProject,
} from "./index.js";
import type { ActorId, EventId, MapData, MapId, Project, Result, SchemaError } from "./index.js";

const fixtureNames = listProjectFixtures(1);

/** ディスク上のフィクスチャを、深いコピーとして取り出す（テスト内で書き換えるため）。 */
function rawMinimal(): { project: Record<string, any>; map: Record<string, any> } {
  const raw = loadRawProject("minimal");
  return structuredClone({ project: raw.project as Record<string, any>, map: raw.maps["map_start"] as Record<string, any> });
}

describe("fixtures/projects/v1", () => {
  it("has the minimal and transfer-demo fixtures", () => {
    expect(fixtureNames).toEqual(expect.arrayContaining(["minimal", "transfer-demo"]));
  });

  describe.each(fixtureNames)("%s", (name) => {
    const raw = loadRawProject(name);

    it("[inv-2] parses with formatVersion === CURRENT", () => {
      const r = parseProject(raw.project);
      expect(r).toMatchObject({ ok: true });
      if (r.ok) expect(r.value.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    });

    it("[inv-2] every map parses", () => {
      for (const [file, json] of Object.entries(raw.maps)) {
        const r = parseMapData(json, raw.formatVersion);
        expect(r.ok, `${file}: ${JSON.stringify(r)}`).toBe(true);
      }
    });

    it("[inv-1] serialize(parse(j)) deep-equals the migrated j (maps: j itself)", () => {
      const r = parseProject(raw.project);
      if (!r.ok) throw new Error("fixture must parse");
      // フィクスチャは v1（旧形式）。読み込むと現行のフォーマットになる（マイグレーション済みの JSON と一致する）
      const migrated = migrateTo(raw.project, CURRENT_FORMAT_VERSION);
      if (!migrated.ok) throw new Error("fixture must migrate");
      expect(serializeProject(r.value)).toEqual(migrated.value);
      for (const json of Object.values(raw.maps)) {
        const m = parseMapData(json, raw.formatVersion);
        if (!m.ok) throw new Error("fixture map must parse");
        expect(serializeMapData(m.value)).toEqual(json);
      }
    });
  });

  it("minimal has one map, one actor and one event", () => {
    const raw = loadRawProject("minimal");
    const project = parseProject(raw.project);
    if (!project.ok) throw new Error("must parse");
    expect(Object.keys(project.value.maps)).toHaveLength(1);
    expect(Object.keys(project.value.database.actors)).toHaveLength(1);
    const map = parseMapData(raw.maps["map_start"], 1);
    if (!map.ok) throw new Error("must parse");
    expect(Object.keys(map.value.events)).toHaveLength(1);
  });
});

describe("parseProject: errors", () => {
  it.each([null, undefined, 42, "str", [], {}])("rejects non-project input %j", (input) => {
    const r = parseProject(input);
    expect(r.ok).toBe(false);
  });

  it("rejects a missing / non-integer formatVersion", () => {
    const { project } = rawMinimal();
    delete project["formatVersion"];
    expect(parseProject(project)).toMatchObject({ ok: false, error: { kind: "invalid" } });
    project["formatVersion"] = 1.5;
    expect(parseProject(project)).toMatchObject({ ok: false, error: { kind: "invalid" } });
  });

  it("rejects a newer formatVersion with kind newer-format", () => {
    const { project } = rawMinimal();
    project["formatVersion"] = CURRENT_FORMAT_VERSION + 1;
    expect(parseProject(project)).toEqual({
      ok: false,
      error: { kind: "newer-format", found: CURRENT_FORMAT_VERSION + 1, supported: CURRENT_FORMAT_VERSION },
    });
  });

  it("reports a missing field with its path", () => {
    const { project } = rawMinimal();
    delete project["system"].startMap;
    const r = parseProject(project);
    expect(r).toMatchObject({ ok: false, error: { kind: "invalid" } });
    if (!r.ok && r.error.kind === "invalid") expect(r.error.issues.map((i) => i.path)).toContain("system.startMap");
  });

  it("reports a wrong type with its path", () => {
    const { project } = rawMinimal();
    project["database"].actors["actor_hero"].initialLevel = "one";
    const r = parseProject(project);
    if (r.ok || r.error.kind !== "invalid") throw new Error("expected invalid");
    expect(r.error.issues.map((i) => i.path)).toContain("database.actors.actor_hero.initialLevel");
  });

  it.each(["", "has space", "colon:id", "日本語", "x".repeat(65)])("rejects malformed id %j", (bad) => {
    const { project } = rawMinimal();
    project["system"].startMap = bad;
    expect(parseProject(project).ok).toBe(false);
  });

  it("rejects unknown keys (typo detection)", () => {
    const { project } = rawMinimal();
    project["system"].startMapp = "x";
    expect(parseProject(project).ok).toBe(false);
  });

  it("[inv-4] rejects a record whose key differs from value.id", () => {
    const { project } = rawMinimal();
    project["database"].actors["actor_other"] = { ...project["database"].actors["actor_hero"] };
    const r = parseProject(project);
    if (r.ok || r.error.kind !== "invalid") throw new Error("expected invalid");
    expect(r.error.issues.map((i) => i.path)).toContain("database.actors.actor_other.id");
  });

  it("[inv-5] rejects an AssetId that is not 16 lowercase hex digits", () => {
    const { project } = rawMinimal();
    const entries = project["assets"].entries;
    entries["ABCDEF0123456789"] = entries["0123456789abcdef"];
    expect(parseProject(project).ok).toBe(false);
  });

  it("never throws on arbitrary JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        expect(typeof parseProject(json).ok).toBe("boolean");
      }),
    );
  });
});

describe("parseMapData", () => {
  it("[inv-3] rejects layers whose tiles.length !== width*height", () => {
    const { map } = rawMinimal();
    map["layers"][0].tiles = map["layers"][0].tiles.slice(1);
    const r = parseMapData(map, 1);
    if (r.ok || r.error.kind !== "invalid") throw new Error("expected invalid");
    expect(r.error.issues.map((i) => i.path)).toContain("layers.0.tiles");
  });

  it("rejects a map with no layers", () => {
    const { map } = rawMinimal();
    map["layers"] = [];
    expect(parseMapData(map, 1).ok).toBe(false);
  });

  it("[inv-4] rejects an event whose key differs from its id", () => {
    const { map } = rawMinimal();
    map["events"]["ev_other"] = map["events"]["ev_npc"];
    expect(parseMapData(map, 1).ok).toBe(false);
  });

  it("rejects an event outside the map", () => {
    const { map } = rawMinimal();
    map["events"]["ev_npc"].x = 10;
    expect(parseMapData(map, 1).ok).toBe(false);
  });

  it("rejects a newer format version and a bad version", () => {
    const { map } = rawMinimal();
    expect(parseMapData(map, CURRENT_FORMAT_VERSION + 1)).toMatchObject({ ok: false, error: { kind: "newer-format" } });
    expect(parseMapData(map, 0).ok).toBe(false);
  });

  it("accepts Uint16Array tiles in memory and serializes them to number[]", () => {
    const { map } = rawMinimal();
    const parsed = parseMapData(map, 1);
    if (!parsed.ok) throw new Error("must parse");
    const inMemory: MapData = { ...parsed.value, layers: parsed.value.layers.map((l) => ({ ...l, tiles: Uint16Array.from(l.tiles) })) };
    expect(MapDataSchema.safeParse(inMemory).success).toBe(true);
    expect(serializeMapData(inMemory)).toEqual(map);
  });
});

describe("properties", () => {
  it("[inv-1] serializeProject(parseProject(j)) round-trips arbitrary valid projects", () => {
    fc.assert(
      fc.property(projectArb, (p) => {
        const json = serializeProject(p);
        const r = parseProject(json);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (r.ok) {
          expect(r.value).toEqual(p);
          expect(serializeProject(r.value)).toEqual(json);
        }
      }),
    );
  });

  it("[inv-1] serializeMapData(parseMapData(j)) round-trips arbitrary valid maps", () => {
    fc.assert(
      fc.property(mapDataArb(), (m) => {
        const json = serializeMapData(m);
        const r = parseMapData(json, 1);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (r.ok) expect(serializeMapData(r.value)).toEqual(json);
      }),
    );
  });

  it("[inv-3] arbitrary maps satisfy tiles.length === width*height", () => {
    fc.assert(
      fc.property(mapDataArb(), (m) => m.layers.length >= 1 && m.layers.every((l) => l.tiles.length === m.width * m.height)),
    );
  });
});

describe("types", () => {
  it("brands ids so that they cannot be mixed up", () => {
    expectTypeOf<MapId>().not.toEqualTypeOf<EventId>();
    expectTypeOf<MapId>().not.toEqualTypeOf<string>();
    expectTypeOf<MapId>().toExtend<string>();
    expectTypeOf<Project["database"]["actors"]>().toEqualTypeOf<Record<ActorId, Project["database"]["actors"][ActorId]>>();
  });

  it("parse functions return Result<_, SchemaError>", () => {
    expectTypeOf(parseProject).returns.toEqualTypeOf<Result<Project, SchemaError>>();
    expectTypeOf(parseMapData).returns.toEqualTypeOf<Result<MapData, SchemaError>>();
  });
});
