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
