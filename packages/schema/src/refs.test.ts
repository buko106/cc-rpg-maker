import { loadRawProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { collectRefs, findDanglingRefs, parseMapData, parseProject } from "./index.js";
import type { EventCommand, MapData, MapId, Project, RefTarget } from "./index.js";

function loadMinimal(): { project: Project; maps: Record<MapId, MapData> } {
  const raw = loadRawProject("minimal");
  const project = parseProject(structuredClone(raw.project));
  const map = parseMapData(structuredClone(raw.maps["map_start"]), 1);
  if (!project.ok || !map.ok) throw new Error("fixture must parse");
  return { project: project.value, maps: { [map.value.id]: map.value } };
}

/** テスト用のコマンド参照解決。`core` のレジストリの代役。 */
const resolve = (c: EventCommand): RefTarget[] => {
  if (c.code === "ControlSwitches") return (c.params["ids"] as string[]).map((id) => ({ kind: "switch", id }));
  if (c.code === "ControlVariables") return (c.params["ids"] as string[]).map((id) => ({ kind: "variable", id }));
  if (c.code === "TransferPlayer") return [{ kind: "map", id: c.params["mapId"] as string }];
  return [];
};

describe("collectRefs / findDanglingRefs", () => {
  it("finds no dangling refs in the minimal fixture", () => {
    const { project, maps } = loadMinimal();
    expect(findDanglingRefs(project, maps, resolve)).toEqual([]);
  });

  it("collects refs from system, database, maps and commands", () => {
    const { project, maps } = loadMinimal();
    const refs = collectRefs(project, maps, resolve);
    const has = (from: string, kind: string, id: string) => refs.some((r) => r.from.startsWith(from) && r.to.kind === kind && r.to.id === id);
    expect(has("system", "map", "map_start")).toBe(true);
    expect(has("system.initialParty", "actor", "actor_hero")).toBe(true);
    expect(has("database.actors.actor_hero", "class", "class_hero")).toBe(true);
    expect(has("map:map_start", "tileset", "ts_basic")).toBe(true);
    expect(has("map:map_start/event:ev_npc/page:1", "switch", "sw_talked")).toBe(true);
    expect(has("map:map_start/event:ev_npc/page:0/command:1", "switch", "sw_talked")).toBe(true);
    expect(has("map:map_start/event:ev_npc/page:0", "asset", "0123456789abcdef")).toBe(true);
  });

  // [名前, project の書き換え, 期待される参照切れ]
  const projectCases: [string, (p: Project) => void, RefTarget][] = [
    ["startMap", (p) => { p.system.startMap = "nomap" as MapId; }, { kind: "map", id: "nomap" }],
    ["initialParty", (p) => { p.system.initialParty = ["ghost" as never]; }, { kind: "actor", id: "ghost" }],
    ["actor class", (p) => { p.database.actors["actor_hero" as never]!.classId = "noclass" as never; }, { kind: "class", id: "noclass" }],
    ["actor equip", (p) => { p.database.actors["actor_hero" as never]!.equips = { weapon: "sword" as never }; }, { kind: "item", id: "sword" }],
    ["actor face asset", (p) => { p.database.actors["actor_hero" as never]!.face = { asset: "ffffffffffffffff" as never }; }, { kind: "asset", id: "ffffffffffffffff" }],
    ["class skill", (p) => { p.database.classes["class_hero" as never]!.skills = [{ level: 1, skill: "noskill" as never }]; }, { kind: "skill", id: "noskill" }],
    ["bgm asset", (p) => { p.system.bgm = { title: { asset: "eeeeeeeeeeeeeeee" as never, volume: 1, pitch: 1, loop: true } }; }, { kind: "asset", id: "eeeeeeeeeeeeeeee" }],
    ["map parent", (p) => { p.maps["map_start" as never]!.parent = "noparent" as never; }, { kind: "map", id: "noparent" }],
  ];
  it.each(projectCases)("detects a dangling ref: %s", (_name, mutate, expected) => {
    const { project, maps } = loadMinimal();
    mutate(project);
    expect(findDanglingRefs(project, maps, resolve)).toEqual([expected]);
  });

  const mapCases: [string, (m: MapData) => void, RefTarget][] = [
    ["tileset", (m) => { m.tileset = "nots" as never; }, { kind: "tileset", id: "nots" }],
    ["encounter troop", (m) => { m.encounters = [{ troop: "notroop" as never, weight: 1 }]; }, { kind: "troop", id: "notroop" }],
    ["page condition switch", (m) => { m.events["ev_npc" as never]!.pages[0]!.conditions = [{ kind: "switch", id: "nosw" as never, value: true }]; }, { kind: "switch", id: "nosw" }],
    ["page condition variable", (m) => { m.events["ev_npc" as never]!.pages[0]!.conditions = [{ kind: "variable", id: "novar" as never, op: ">=", value: 1 }]; }, { kind: "variable", id: "novar" }],
    ["command ref (via resolver)", (m) => { m.events["ev_npc" as never]!.pages[0]!.commands.push({ code: "TransferPlayer", params: { mapId: "gone" }, indent: 0 }); }, { kind: "map", id: "gone" }],
  ];
  it.each(mapCases)("detects a dangling ref in a map: %s", (_name, mutate, expected) => {
    const { project, maps } = loadMinimal();
    mutate(maps["map_start" as MapId]!);
    expect(findDanglingRefs(project, maps, resolve)).toEqual([expected]);
  });

  it("reports each dangling target once", () => {
    const { project, maps } = loadMinimal();
    const ev = maps["map_start" as MapId]!.events["ev_npc" as never]!;
    ev.pages[0]!.commands.push({ code: "TransferPlayer", params: { mapId: "gone" }, indent: 0 }, { code: "TransferPlayer", params: { mapId: "gone" }, indent: 0 });
    expect(findDanglingRefs(project, maps, resolve)).toEqual([{ kind: "map", id: "gone" }]);
  });

  it("is not fooled by prototype keys as ids", () => {
    const { project, maps } = loadMinimal();
    project.system.initialParty = ["constructor" as never, "toString" as never];
    expect(findDanglingRefs(project, maps, resolve)).toEqual([
      { kind: "actor", id: "constructor" },
      { kind: "actor", id: "toString" },
    ]);
  });
});

describe("collectRefs: every reference site", () => {
  const A = "aaaaaaaaaaaaaaaa";
  /** あらゆる場所から存在しない ID を参照する Project。 */
  function kitchenSink(): { project: Project; maps: Record<MapId, MapData> } {
    const { project, maps } = loadMinimal();
    const map = maps["map_start" as MapId]!;
    const audio = { asset: "b".repeat(16) as never, volume: 1, pitch: 1, loop: false };
    const p: Project = {
      ...project,
      tilesets: { ts_basic: { ...project.tilesets["ts_basic" as never]!, image: { asset: A as never } } } as never,
      maps: { map_start: { ...project.maps["map_start" as never]!, parent: "m_parent" as never } } as never,
      system: { ...project.system, bgm: { title: audio, battle: { ...audio, asset: "c".repeat(16) as never } } },
      database: {
        actors: { actor_hero: { ...project.database.actors["actor_hero" as never]!, walk: { asset: "d".repeat(16) as never } } } as never,
        classes: project.database.classes,
        skills: { sk: { id: "sk", name: "s", mpCost: 0, scope: "self", formula: "1", animation: { asset: "e".repeat(16) }, effects: [{ kind: "commonEvent", id: "ce_x" }] } } as never,
        items: { it: { id: "it", name: "i", kind: "consumable", price: 0, effects: [{ kind: "commonEvent", id: "ce_y" }, { kind: "recoverHp", value: 1 }] } } as never,
        enemies: { en: { id: "en", name: "e", params: { mhp: 1, mmp: 1, atk: 1, def: 1, mat: 1, mdf: 1, agi: 1, luk: 1 }, actions: [{ skill: "sk_x", rating: 1 }], drops: [{ item: "it_x", rate: 1 }], exp: 0, gold: 0 } } as never,
        troops: { tr: { id: "tr", name: "t", members: [{ enemy: "en_x", x: 0, y: 0 }], pages: [{ condition: { kind: "switch", id: "sw_x" }, commands: [{ code: "TransferPlayer", params: { mapId: "m_tr" }, indent: 0 }] }, { condition: { kind: "always" }, commands: [] }] } } as never,
        commonEvents: { ce: { id: "ce", name: "c", trigger: "autorun", switch: "sw_ce", commands: [{ code: "TransferPlayer", params: { mapId: "m_ce" }, indent: 0 }] } } as never,
      },
    };
    const m: MapData = {
      ...map,
      bgm: { ...audio, asset: "f".repeat(16) as never },
      encounters: [{ troop: "tr_x" as never, weight: 1 }],
      events: {
        ev_npc: {
          ...map.events["ev_npc" as never]!,
          pages: [{ ...map.events["ev_npc" as never]!.pages[0]!, conditions: [{ kind: "item", id: "it_c" as never }, { kind: "actor", id: "ac_c" as never }, { kind: "selfSwitch", key: "A", value: true }] }],
        },
      } as never,
    };
    return { project: p, maps: { map_start: m } as never };
  }

  it("reaches asset, effect, database, troop, common event and page-condition references", () => {
    const { project, maps } = kitchenSink();
    const dangling = findDanglingRefs(project, maps, resolve);
    const key = (t: RefTarget) => `${t.kind}:${t.id}`;
    expect(dangling.map(key).sort()).toEqual(
      [
        `asset:${A}`, "map:m_parent", "asset:" + "b".repeat(16), "asset:" + "c".repeat(16), "asset:" + "d".repeat(16), "asset:" + "e".repeat(16), "asset:" + "f".repeat(16),
        "commonEvent:ce_x", "commonEvent:ce_y", "skill:sk_x", "item:it_x", "enemy:en_x", "switch:sw_x", "map:m_tr", "switch:sw_ce", "map:m_ce",
        "troop:tr_x", "item:it_c", "actor:ac_c",
      ].sort(),
    );
  });

  it("labels each reference with where it comes from", () => {
    const { project, maps } = kitchenSink();
    const refs = collectRefs(project, maps, resolve);
    const from = (kind: string, id: string) => refs.find((r) => r.to.kind === kind && r.to.id === id)?.from;
    expect(from("troop", "tr_x")).toBe("map:map_start");
    expect(from("map", "m_tr")).toBe("database.troops.tr/page:0/command:0");
    expect(from("map", "m_ce")).toBe("database.commonEvents.ce/command:0");
    expect(from("commonEvent", "ce_x")).toBe("database.skills.sk");
    expect(from("actor", "ac_c")).toBe("map:map_start/event:ev_npc/page:0");
  });
});
