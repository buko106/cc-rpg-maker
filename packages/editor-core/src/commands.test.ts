import { createMemoryProjectRepository } from "@rpg/project-store";
import type { ProjectDocument } from "@rpg/project-store";
import type { AssetId, EventId, MapId, TilesetId } from "@rpg/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { batch } from "./command.js";
import type { EditorCommand } from "./command.js";
import { blankLayers, cmd, defaultPage, eventCommand } from "./commands/index.js";

const M1 = "map_001" as MapId;
let base: ProjectDocument;

beforeAll(async () => {
  base = await createMemoryProjectRepository().create("t");
});

/** 適用して、Undo（invert）で元に戻ることまで確かめる。 */
function applied(c: EditorCommand, doc = base): ProjectDocument {
  const r = c.apply(doc);
  if (!r.ok) throw new Error(`apply が失敗: ${JSON.stringify(r.error)}`);
  const back = c.invert(doc, r.value).apply(r.value);
  expect(back.ok && back.value).toEqual(doc);
  return r.value;
}

const failure = (c: EditorCommand, doc = base) => {
  const r = c.apply(doc);
  if (r.ok) throw new Error("apply が成功してしまった");
  return r.error;
};

const tilesOf = (doc: ProjectDocument, layer = 0): number[] => Array.from(doc.maps[M1]!.layers[layer]!.tiles);

describe("map commands", () => {
  it("paintTiles：置く・同じなら文書はそのまま・範囲外や不正なタイルは invalid", () => {
    const next = applied(cmd.paintTiles(M1, 1, [{ x: 2, y: 1, tile: 4 }, { x: 0, y: 0, tile: 5 }]));
    expect(tilesOf(next, 1)[1 * 20 + 2]).toBe(4);
    expect(tilesOf(next, 1)[0]).toBe(5);
    expect(tilesOf(base, 1)[0]).toBe(0); // 元の文書は変わらない
    expect(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 1 }]).apply(base)).toEqual({ ok: true, value: base }); // 草のまま
    expect(failure(cmd.paintTiles(M1, 0, [{ x: 20, y: 0, tile: 1 }])).kind).toBe("invalid");
    expect(failure(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: -1 }])).kind).toBe("invalid");
    expect(failure(cmd.paintTiles(M1, 9, [{ x: 0, y: 0, tile: 1 }])).kind).toBe("invalid");
    expect(failure(cmd.paintTiles("nope" as MapId, 0, [])).kind).toBe("notFound");
  });

  it("paintTiles の coalesce は同じマップ・レイヤだけ、両方の効果を含む", () => {
    const a = cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 2 }]);
    const b = cmd.paintTiles(M1, 0, [{ x: 1, y: 0, tile: 3 }]);
    const merged = b.coalesce!(a)!;
    const doc = applied(merged);
    expect(tilesOf(doc).slice(0, 2)).toEqual([2, 3]);
    expect(b.coalesce!(cmd.paintTiles(M1, 1, []))).toBeUndefined();
    expect(b.coalesce!(cmd.fillTiles(M1, 0, 0, 0, 1))).toBeUndefined();
  });

  it("fillTiles：つながった同じタイルだけを塗る", () => {
    const walled = applied(cmd.batch("壁", Array.from({ length: 15 }, (_, y) => cmd.paintTiles(M1, 0, [{ x: 10, y, tile: 2 }]))));
    const filled = applied(cmd.fillTiles(M1, 0, 0, 0, 3), walled);
    expect(tilesOf(filled)[0]).toBe(3);
    expect(tilesOf(filled)[9]).toBe(3);
    expect(tilesOf(filled)[10]).toBe(2); // 壁は残る
    expect(tilesOf(filled)[11]).toBe(1); // 壁の向こうは塗られない
    expect(cmd.fillTiles(M1, 0, 0, 0, 1).apply(base)).toEqual({ ok: true, value: base });
    expect(failure(cmd.fillTiles(M1, 0, 99, 0, 3)).kind).toBe("invalid");
    expect(failure(cmd.fillTiles(M1, 0, 0, 0, 70000)).kind).toBe("invalid");
  });

  it("resizeMap：anchor 側を固定して内容を寄せ、はみ出したイベントを消し、開始位置を追従させる", () => {
    const withEvents = applied(cmd.batch("e", [cmd.createEvent(M1, 19, 14, "ev_far" as EventId), cmd.createEvent(M1, 2, 2, "ev_near" as EventId), cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 6 }])]));
    const small = applied(cmd.resizeMap(M1, 10, 10, "nw"), withEvents);
    const map = small.maps[M1]!;
    expect([map.width, map.height, map.layers[0]!.tiles.length]).toEqual([10, 10, 100]);
    expect(Object.keys(map.events)).toEqual(["ev_near"]);
    expect(map.layers[0]!.tiles[0]).toBe(6);

    const grown = applied(cmd.resizeMap(M1, 24, 19, "se"), withEvents);
    expect(grown.maps[M1]!.events["ev_near" as EventId]).toMatchObject({ x: 6, y: 6 });
    expect(grown.maps[M1]!.layers[0]!.tiles[4 * 24 + 4]).toBe(6);
    expect(grown.maps[M1]!.layers[0]!.tiles[0]).toBe(0); // 増えた部分は空
    expect(grown.project.system).toMatchObject({ startX: 9, startY: 9 });

    const centered = applied(cmd.resizeMap(M1, 22, 17, "c"), withEvents);
    expect(centered.maps[M1]!.events["ev_near" as EventId]).toMatchObject({ x: 3, y: 3 });
    const shrunk = applied(cmd.resizeMap(M1, 2, 2, "se"), withEvents);
    expect(shrunk.project.system).toMatchObject({ startX: 0, startY: 0 }); // 範囲内に収める

    expect(cmd.resizeMap(M1, 20, 15, "nw").apply(base)).toEqual({ ok: true, value: base });
    expect(failure(cmd.resizeMap(M1, 0, 5, "nw")).kind).toBe("invalid");
    expect(failure(cmd.resizeMap(M1, 5, 5000, "nw")).kind).toBe("invalid");
    expect(failure(cmd.resizeMap("nope" as MapId, 5, 5, "nw")).kind).toBe("notFound");
  });

  it("createMap / deleteMap / setMapMeta / setMapProperties", () => {
    const created = applied(cmd.createMap({ name: "新しい", order: 1 }, { width: 5, height: 4 }, "map_new" as MapId));
    expect(created.project.maps["map_new" as MapId]).toEqual({ id: "map_new", name: "新しい", order: 1 });
    expect(created.maps["map_new" as MapId]).toMatchObject({ width: 5, height: 4, tileset: "ts_default" });
    expect(created.maps["map_new" as MapId]!.layers.map((l) => l.tiles.length)).toEqual([20, 20]);
    expect(failure(cmd.createMap({ name: "x", order: 0 }, {}, M1)).kind).toBe("duplicate");
    expect(failure(cmd.createMap({ name: "x", order: 0 }, {}, "m2" as MapId), { ...base, project: { ...base.project, tilesets: {} } }).kind).toBe("invalid");
    expect(cmd.createMap({ name: "自動", order: 0 }).apply(base)).toMatchObject({ ok: true });

    const deleted = applied(cmd.deleteMap("map_new" as MapId), created);
    expect(Object.keys(deleted.maps)).toEqual([M1]);
    expect(failure(cmd.deleteMap("nope" as MapId)).kind).toBe("notFound");
    expect(cmd.deleteMap(M1).removes()).toEqual([{ kind: "map", id: M1 }]);

    const renamed = applied(cmd.setMapMeta(M1, { name: "村" }));
    expect(renamed.project.maps[M1]!.name).toBe("村");
    const child = applied(cmd.setMapMeta("map_new" as MapId, { parent: M1 }), created);
    expect(child.project.maps["map_new" as MapId]!.parent).toBe(M1);
    expect(applied(cmd.setMapMeta("map_new" as MapId, { parent: null }), child).project.maps["map_new" as MapId]).not.toHaveProperty("parent");
    expect(failure(cmd.setMapMeta(M1, { parent: "map_new" as MapId }), child).kind).toBe("invalid"); // 循環
    expect(failure(cmd.setMapMeta(M1, { parent: "nope" as MapId })).kind).toBe("notFound");
    expect(failure(cmd.setMapMeta("nope" as MapId, {})).kind).toBe("notFound");

    const props = applied(cmd.setMapProperties(M1, { bgm: { asset: "aaaaaaaaaaaaaaaa" as AssetId, volume: 1, pitch: 1, loop: true }, encounters: [{ troop: "t" as never, weight: 1 }] }));
    expect(props.maps[M1]!.bgm?.asset).toBe("aaaaaaaaaaaaaaaa");
    const cleared = applied(cmd.setMapProperties(M1, { bgm: null, encounters: null, tileset: "ts_default" as TilesetId }), props);
    expect(cleared.maps[M1]).not.toHaveProperty("bgm");
    expect(cleared.maps[M1]).not.toHaveProperty("encounters");
    expect(failure(cmd.setMapProperties("nope" as MapId, {})).kind).toBe("notFound");
  });

  it("blankLayers は空のレイヤを必要な数だけ作る", () => {
    expect(blankLayers(3, 2, ["a"])).toEqual([{ name: "a", tiles: [0, 0, 0, 0, 0, 0] }]);
  });
});

describe("event commands", () => {
  const ev = "ev_a" as EventId;
  const withEvent = (): ProjectDocument => applied(cmd.createEvent(M1, 3, 4, ev));
  const page = (): ReturnType<typeof defaultPage> => ({ ...defaultPage(), commands: [eventCommand("ShowText", { text: "a" }), eventCommand("Wait", { frames: 1 })] });

  it("createEvent：既定のページを 1 つ持つ。範囲外・重複はエラー", () => {
    const doc = withEvent();
    expect(doc.maps[M1]!.events[ev]).toEqual({ id: ev, name: "EV001", x: 3, y: 4, pages: [defaultPage()] });
    expect(failure(cmd.createEvent(M1, 3, 4, ev), doc).kind).toBe("duplicate");
    expect(failure(cmd.createEvent(M1, 20, 0, "x" as EventId)).kind).toBe("invalid");
    expect(failure(cmd.createEvent("nope" as MapId, 0, 0)).kind).toBe("notFound");
    const auto = cmd.createEvent(M1, 0, 0).apply(base);
    expect(auto.ok && Object.keys(auto.value.maps[M1]!.events)).toHaveLength(1);
  });

  it("moveEvent / deleteEvent / setEventName", () => {
    const doc = withEvent();
    expect(applied(cmd.moveEvent(M1, ev, 5, 6), doc).maps[M1]!.events[ev]).toMatchObject({ x: 5, y: 6 });
    expect(cmd.moveEvent(M1, ev, 3, 4).apply(doc)).toEqual({ ok: true, value: doc });
    expect(failure(cmd.moveEvent(M1, ev, 50, 0), doc).kind).toBe("invalid");
    expect(failure(cmd.moveEvent(M1, "no" as EventId, 0, 0), doc).kind).toBe("notFound");
    expect(applied(cmd.deleteEvent(M1, ev), doc).maps[M1]!.events).toEqual({});
    expect(failure(cmd.deleteEvent(M1, "no" as EventId), doc).kind).toBe("notFound");
    expect(applied(cmd.setEventName(M1, ev, "看板"), doc).maps[M1]!.events[ev]!.name).toBe("看板");
    expect(cmd.setEventName(M1, ev, "EV001").apply(doc)).toEqual({ ok: true, value: doc });
  });

  it("pasteEvent：ページを複製して新しい ID で置く。別のマップにも貼れて、元の編集の影響を受けない", () => {
    const M2 = "map_new" as MapId;
    let doc = applied(cmd.setEventPage(M1, ev, 0, page()), withEvent());
    doc = applied(cmd.setEventName(M1, ev, "看板"), doc);
    const source = doc.maps[M1]!.events[ev]!;
    const pasted = applied(cmd.pasteEvent(M1, source, 6, 7, "ev_b" as EventId), doc);
    const copy = pasted.maps[M1]!.events["ev_b" as EventId]!;
    expect(copy).toMatchObject({ id: "ev_b", name: "看板", x: 6, y: 7 });
    expect(copy.pages).toEqual(source.pages);
    expect(copy.pages).not.toBe(source.pages);
    expect(copy.pages[0]!.commands[0]).not.toBe(source.pages[0]!.commands[0]);
    // 元を削除・編集しても、スナップショットからは貼れる
    const gone = applied(cmd.deleteEvent(M1, ev), pasted);
    expect(applied(cmd.pasteEvent(M1, source, 3, 4, "ev_c" as EventId), gone).maps[M1]!.events["ev_c" as EventId]).toMatchObject({ name: "看板", x: 3, y: 4 });
    // ID を省略すると採番される（元の ID とは別）
    const auto = applied(cmd.pasteEvent(M1, source, 0, 0), doc);
    expect(Object.keys(auto.maps[M1]!.events)).toHaveLength(2);
    // 別のマップへ
    const other = applied(cmd.createMap({ name: "新しい", order: 1 }, { width: 5, height: 4 }, M2), doc);
    expect(Object.values(applied(cmd.pasteEvent(M2, source, 4, 3), other).maps[M2]!.events)).toEqual([expect.objectContaining({ name: "看板", x: 4, y: 3 })]);
  });

  it("pasteEvent：範囲外・別のイベントがあるセル・ID の重複・マップが無いときはエラー。Undo で戻る", () => {
    const doc = withEvent();
    const source = doc.maps[M1]!.events[ev]!;
    expect(failure(cmd.pasteEvent(M1, source, 20, 0), doc).kind).toBe("invalid");
    expect(failure(cmd.pasteEvent(M1, source, 3, 4, "ev_b" as EventId), doc)).toMatchObject({ kind: "duplicate" }); // 元と同じセルには重ねられない
    expect(failure(cmd.pasteEvent(M1, source, 0, 0, ev), doc).kind).toBe("duplicate");
    expect(failure(cmd.pasteEvent("nope" as MapId, source, 0, 0), doc).kind).toBe("notFound");
    const c = cmd.pasteEvent(M1, source, 1, 1, "ev_b" as EventId);
    const after = applied(c, doc);
    expect(c.touchedMaps()).toEqual([M1]);
    expect(c.invert(doc, after).apply(after)).toMatchObject({ ok: true });
  });

  it("moveEvent と setEventName は同じイベントの連続だけまとまる", () => {
    const a = cmd.moveEvent(M1, ev, 1, 1);
    const b = cmd.moveEvent(M1, ev, 2, 2);
    expect(applied(b.coalesce!(a)!, withEvent()).maps[M1]!.events[ev]).toMatchObject({ x: 2, y: 2 });
    expect(b.coalesce!(cmd.moveEvent(M1, "other" as EventId, 1, 1))).toBeUndefined();
    expect(b.coalesce!(cmd.setEventName(M1, ev, "x"))).toBeUndefined();
    const n = cmd.setEventName(M1, ev, "b");
    expect(n.coalesce!(cmd.setEventName(M1, ev, "a"))).toBeDefined();
    expect(n.coalesce!(cmd.setEventName(M1, "other" as EventId, "a"))).toBeUndefined();
  });

  it("setEventPage：置き換え・末尾に追加・範囲外はエラー、removeEventPage は最後の 1 ページを残す", () => {
    const doc = withEvent();
    const replaced = applied(cmd.setEventPage(M1, ev, 0, page()), doc);
    expect(replaced.maps[M1]!.events[ev]!.pages[0]!.commands).toHaveLength(2);
    const appended = applied(cmd.setEventPage(M1, ev, 1, defaultPage()), replaced);
    expect(appended.maps[M1]!.events[ev]!.pages).toHaveLength(2);
    expect(failure(cmd.setEventPage(M1, ev, 3, defaultPage()), doc).kind).toBe("invalid");
    expect(applied(cmd.removeEventPage(M1, ev, 0), appended).maps[M1]!.events[ev]!.pages).toHaveLength(1);
    expect(failure(cmd.removeEventPage(M1, ev, 0), doc).kind).toBe("invalid");
    expect(failure(cmd.removeEventPage(M1, ev, 5), doc).kind).toBe("notFound");
    const c = cmd.setEventPage(M1, ev, 0, page());
    expect(c.coalesce!(cmd.setEventPage(M1, ev, 0, defaultPage()))).toBeDefined();
    expect(c.coalesce!(cmd.setEventPage(M1, ev, 1, defaultPage()))).toBeUndefined();
  });

  it("insertCommands / removeCommands / replaceCommand", () => {
    const doc = applied(cmd.setEventPage(M1, ev, 0, page()), withEvent());
    const inserted = applied(cmd.insertCommands(M1, ev, 0, 1, [eventCommand("Wait", { frames: 9 })]), doc);
    expect(inserted.maps[M1]!.events[ev]!.pages[0]!.commands.map((c) => c.code)).toEqual(["ShowText", "Wait", "Wait"]);
    expect(failure(cmd.insertCommands(M1, ev, 0, 5, []), doc).kind).toBe("invalid");
    expect(failure(cmd.insertCommands(M1, ev, 3, 0, []), doc).kind).toBe("notFound");
    expect(failure(cmd.insertCommands(M1, "no" as EventId, 0, 0, []), doc).kind).toBe("notFound");

    expect(applied(cmd.removeCommands(M1, ev, 0, 0, 2), doc).maps[M1]!.events[ev]!.pages[0]!.commands).toEqual([]);
    expect(failure(cmd.removeCommands(M1, ev, 0, 1, 2), doc).kind).toBe("invalid");
    expect(failure(cmd.removeCommands(M1, ev, 0, -1, 1), doc).kind).toBe("invalid");

    const replaced = applied(cmd.replaceCommand(M1, ev, 0, 0, eventCommand("ShowText", { text: "b" })), doc);
    expect(replaced.maps[M1]!.events[ev]!.pages[0]!.commands[0]!.params).toEqual({ text: "b" });
    expect(failure(cmd.replaceCommand(M1, ev, 0, 7, eventCommand("Wait")), doc).kind).toBe("notFound");
    const r = cmd.replaceCommand(M1, ev, 0, 0, eventCommand("Wait"));
    expect(r.coalesce!(cmd.replaceCommand(M1, ev, 0, 0, eventCommand("ShowText")))).toBeDefined();
    expect(r.coalesce!(cmd.replaceCommand(M1, ev, 0, 1, eventCommand("ShowText")))).toBeUndefined();
    expect(r.coalesce!(cmd.insertCommands(M1, ev, 0, 0, []))).toBeUndefined();
  });
});

describe("database / system commands", () => {
  const item = { id: "item_x", name: "薬", kind: "consumable", price: 5, effects: [] } as never;

  it("upsertEntity：追加・置き換え・同じ実体ならそのまま。deleteEntity は removes に対象を挙げる", () => {
    const added = applied(cmd.upsertEntity("items", item));
    expect(added.project.database.items["item_x" as never]).toMatchObject({ name: "薬" });
    const renamed = applied(cmd.upsertEntity("items", { ...(item as object), name: "強い薬" } as never), added);
    expect(renamed.project.database.items["item_x" as never]).toMatchObject({ name: "強い薬" });
    expect(cmd.upsertEntity("items", added.project.database.items["item_x" as never]!).apply(added)).toEqual({ ok: true, value: added });
    const removed = applied(cmd.deleteEntity("items", "item_x"), added);
    expect(removed.project.database.items).toEqual({});
    expect(failure(cmd.deleteEntity("items", "item_x")).kind).toBe("notFound");
    expect(cmd.deleteEntity("troops", "t1").removes()).toEqual([{ kind: "troop", id: "t1" }]);
    expect(cmd.deleteEntity("commonEvents", "c").removes()).toEqual([{ kind: "commonEvent", id: "c" }]);
    const c = cmd.upsertEntity("items", item);
    expect(c.coalesce!(cmd.upsertEntity("items", item))).toBeDefined();
    expect(c.coalesce!(cmd.upsertEntity("skills", { id: "item_x" } as never))).toBeUndefined();
    expect(c.coalesce!(cmd.upsertEntity("items", { ...(item as object), id: "other" } as never))).toBeUndefined();
  });

  it("setSystem：一部だけ変える。同じキーの連続だけまとまる", () => {
    const doc = applied(cmd.setSystem({ startX: 7 }));
    expect(doc.project.system.startX).toBe(7);
    expect(doc.project.system.startY).toBe(5);
    const a = cmd.setSystem({ startX: 1 });
    expect(cmd.setSystem({ startX: 2 }).coalesce!(a)).toBeDefined();
    expect(cmd.setSystem({ startY: 2 }).coalesce!(a)).toBeUndefined();
    expect(cmd.setSystem({ startX: 2 }).coalesce!(cmd.setSwitchName("s" as never, "x"))).toBeUndefined();
  });

  it("registerAsset / unregisterAsset", () => {
    const id = "aaaaaaaaaaaaaaaa" as AssetId;
    const entry = { name: "a.png", kind: "image", mime: "image/png", size: 3 } as const;
    const doc = applied(cmd.registerAsset(id, entry));
    expect(doc.project.assets.entries[id]).toEqual(entry);
    expect(applied(cmd.unregisterAsset(id), doc).project.assets.entries[id]).toBeUndefined();
    expect(failure(cmd.unregisterAsset(id)).kind).toBe("notFound");
    expect(cmd.unregisterAsset(id).removes()).toEqual([{ kind: "asset", id }]);
  });

  it("スイッチ・変数の名前と削除", () => {
    const sw = applied(cmd.setSwitchName("sw1" as never, "扉"));
    expect(sw.project.switches["sw1" as never]).toEqual({ name: "扉" });
    expect(applied(cmd.removeSwitch("sw1" as never), sw).project.switches).toEqual({});
    expect(failure(cmd.removeSwitch("sw1" as never)).kind).toBe("notFound");
    const v = applied(cmd.setVariableName("v1" as never, "回数"));
    expect(applied(cmd.removeVariable("v1" as never), v).project.variables).toEqual({});
    expect(failure(cmd.removeVariable("v1" as never)).kind).toBe("notFound");
    expect(cmd.removeVariable("v1" as never).removes()).toEqual([{ kind: "variable", id: "v1" }]);
  });

  it("upsertTileset / deleteTileset", () => {
    const ts = { id: "ts2", name: "二つ目", passage: [15, 0] } as never;
    const doc = applied(cmd.upsertTileset(ts));
    expect(Object.keys(doc.project.tilesets)).toEqual(["ts_default", "ts2"]);
    expect(failure(cmd.upsertTileset({ id: "ts3", name: "x", passage: [16] } as never)).kind).toBe("invalid");
    expect(applied(cmd.deleteTileset("ts2" as TilesetId), doc).project.tilesets["ts2" as TilesetId]).toBeUndefined();
    expect(failure(cmd.deleteTileset("nope" as TilesetId)).kind).toBe("notFound");
    expect(cmd.deleteTileset("ts2" as TilesetId).removes()).toEqual([{ kind: "tileset", id: "ts2" }]);
  });
});

describe("batch", () => {
  it("順に適用し、途中で失敗したら全体が失敗する。touchedMaps / removes をまとめる", () => {
    const c = batch("まとめ", [cmd.createEvent(M1, 1, 1, "ev_1" as EventId), cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 3 }]), cmd.deleteEntity("items", "x")]);
    expect(c.touchedMaps()).toEqual([M1]);
    expect(c.touchesProject()).toBe(true);
    expect(c.removes()).toEqual([{ kind: "item", id: "x" }]);
    expect(c.apply(base).ok).toBe(false); // items x が無い
    const ok = batch("ok", [cmd.createEvent(M1, 1, 1, "ev_1" as EventId), cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 3 }])]);
    const doc = applied(ok);
    expect(Object.keys(doc.maps[M1]!.events)).toEqual(["ev_1"]);
    expect(tilesOf(doc)[0]).toBe(3);
  });
});
