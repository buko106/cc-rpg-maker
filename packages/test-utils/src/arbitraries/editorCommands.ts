import fc from "fast-check";
import type { EventId, MapId, ItemId, SkillId, StateId, SwitchId } from "@rpg/schema";
import { cmd, defaultPage, eventCommand } from "@rpg/editor-core";
import type { Anchor, EditorCommand } from "@rpg/editor-core";
import type { ProjectDocument } from "@rpg/project-store";

const suffix = fc.stringMatching(/^[a-z0-9]{1,6}$/);
const anchors: readonly Anchor[] = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"];

/** 実在するコマンドで、パラメータも正しいもの。 */
const eventCommandArb = (switches: readonly string[]): fc.Arbitrary<ReturnType<typeof eventCommand>> => {
  const options: fc.Arbitrary<ReturnType<typeof eventCommand>>[] = [
    fc.string({ maxLength: 20 }).map((text) => eventCommand("ShowText", { text })),
    fc.integer({ min: 0, max: 60 }).map((frames) => eventCommand("Wait", { frames })),
  ];
  if (switches.length > 0) {
    options.push(fc.record({ id: fc.constantFrom(...switches), value: fc.boolean() }).map((p) => eventCommand("ControlSwitches", { ids: [p.id], value: p.value })));
  }
  return fc.oneof(...options);
};

/**
 * `doc` に対して発行しうる EditorCommand を生成する。ほとんどは適用できる（Ok）が、
 * 参照が残る削除・重複 ID の作成のように、失敗する（Err）ものも混ざる。
 * 適用できるコマンドは、適用後も `validate()` がエラーを返さない文書になる（force なし）。
 */
export function editorCommandArb(doc: ProjectDocument): fc.Arbitrary<EditorCommand> {
  const { project } = doc;
  const mapIds = Object.keys(doc.maps) as MapId[];
  const switches = Object.keys(project.switches);
  const map = fc.constantFrom(...mapIds);

  const withMap = <T>(f: (m: MapId) => fc.Arbitrary<T>): fc.Arbitrary<T> => map.chain(f);
  const events = (m: MapId): EventId[] => Object.keys(doc.maps[m]?.events ?? {}) as EventId[];

  const options: [number, fc.Arbitrary<EditorCommand>][] = [];
  const add = (weight: number, arb: fc.Arbitrary<EditorCommand>): void => {
    options.push([weight, arb]);
  };

  add(
    6,
    withMap((m) => {
      const { width, height, layers } = doc.maps[m]!;
      return fc
        .record({
          layer: fc.integer({ min: 0, max: layers.length - 1 }),
          cells: fc.array(fc.record({ x: fc.integer({ min: 0, max: width - 1 }), y: fc.integer({ min: 0, max: height - 1 }), tile: fc.integer({ min: 0, max: 6 }) }), { minLength: 1, maxLength: 8 }),
        })
        .map(({ layer, cells }) => cmd.paintTiles(m, layer, cells));
    }),
  );
  add(
    2,
    withMap((m) => {
      const { width, height, layers } = doc.maps[m]!;
      return fc
        .record({ layer: fc.integer({ min: 0, max: layers.length - 1 }), x: fc.integer({ min: 0, max: width - 1 }), y: fc.integer({ min: 0, max: height - 1 }), tile: fc.integer({ min: 0, max: 6 }) })
        .map((p) => cmd.fillTiles(m, p.layer, p.x, p.y, p.tile));
    }),
  );
  add(2, withMap((m) => fc.record({ w: fc.integer({ min: 1, max: 30 }), h: fc.integer({ min: 1, max: 30 }), a: fc.constantFrom(...anchors) }).map((p) => cmd.resizeMap(m, p.w, p.h, p.a))));
  add(1, suffix.map((s) => cmd.createMap({ name: `map ${s}`, order: 5 }, { width: 8, height: 6 }, `gen_${s}` as MapId)));
  add(1, withMap((m) => fc.constant(cmd.deleteMap(m))));
  add(2, withMap((m) => fc.record({ name: fc.string({ maxLength: 8 }), order: fc.integer({ min: -3, max: 9 }) }).map((p) => cmd.setMapMeta(m, p))));

  add(
    4,
    withMap((m) => {
      const { width, height } = doc.maps[m]!;
      return fc.record({ x: fc.integer({ min: 0, max: width - 1 }), y: fc.integer({ min: 0, max: height - 1 }), id: suffix }).map((p) => cmd.createEvent(m, p.x, p.y, `ev_${p.id}` as EventId));
    }),
  );
  const populated = mapIds.filter((m) => events(m).length > 0);
  if (populated.length > 0) {
    const target = fc.constantFrom(...populated).chain((m) => fc.constantFrom(...events(m)).map((e) => ({ m, e, ev: doc.maps[m]!.events[e]! })));
    add(3, target.chain(({ m, e }) => fc.record({ x: fc.integer({ min: 0, max: doc.maps[m]!.width - 1 }), y: fc.integer({ min: 0, max: doc.maps[m]!.height - 1 }) }).map((p) => cmd.moveEvent(m, e, p.x, p.y))));
    add(1, target.map(({ m, e }) => cmd.deleteEvent(m, e)));
    add(1, target.chain(({ m, e }) => fc.string({ maxLength: 8 }).map((n) => cmd.setEventName(m, e, n))));
    add(2, target.chain(({ m, e, ev }) => fc.constantFrom(cmd.setEventPage(m, e, ev.pages.length, defaultPage()), cmd.setEventPage(m, e, 0, { ...defaultPage(), trigger: "touch" }))));
    add(1, target.map(({ m, e, ev }) => cmd.removeEventPage(m, e, ev.pages.length - 1)));
    add(
      4,
      target.chain(({ m, e, ev }) =>
        fc
          .record({ page: fc.integer({ min: 0, max: ev.pages.length - 1 }), items: fc.array(eventCommandArb(switches), { minLength: 1, maxLength: 3 }) })
          .chain(({ page, items }) => fc.integer({ min: 0, max: ev.pages[page]!.commands.length }).map((at) => cmd.insertCommands(m, e, page, at, items))),
      ),
    );
    // コマンドを持つページのあるイベントだけを（フィルタではなく）先に絞る。無ければこの 2 種は作らない
    const holders = populated.flatMap((m) =>
      events(m).flatMap((e) => {
        const ev = doc.maps[m]!.events[e]!;
        return ev.pages.flatMap((p, i) => (p.commands.length > 0 ? [{ m, e, page: i, count: p.commands.length }] : []));
      }),
    );
    if (holders.length > 0) {
      const holder = fc.constantFrom(...holders);
      add(2, holder.chain(({ m, e, page, count }) => fc.integer({ min: 0, max: count - 1 }).chain((at) => fc.integer({ min: 1, max: count - at }).map((n) => cmd.removeCommands(m, e, page, at, n)))));
      add(2, holder.chain(({ m, e, page, count }) => fc.integer({ min: 0, max: count - 1 }).chain((at) => eventCommandArb(switches).map((c) => cmd.replaceCommand(m, e, page, at, c)))));
    }
  }

  // データベース
  add(2, suffix.map((s) => cmd.upsertEntity("items", { id: `item_${s}` as ItemId, name: `道具${s}`, kind: "consumable", price: 10, effects: [] })));
  add(1, suffix.map((s) => cmd.upsertEntity("skills", { id: `sk_${s}` as SkillId, name: `技${s}`, mpCost: 1, scope: "one-enemy", formula: "a.atk", effects: [] })));
  add(1, suffix.map((s) => cmd.upsertEntity("states", { id: `st_${s}` as StateId, name: `状態${s}`, restriction: "none", turns: 3, paramRates: {}, hpRegen: 0 })));
  const actors = Object.values(project.database.actors);
  if (actors.length > 0) add(2, fc.constantFrom(...actors).chain((a) => fc.string({ maxLength: 6 }).map((name) => cmd.upsertEntity("actors", { ...a, name }))));
  const entityRefs: [string, string[]][] = [
    ["items", Object.keys(project.database.items)],
    ["skills", Object.keys(project.database.skills)],
    ["states", Object.keys(project.database.states)],
    ["actors", Object.keys(project.database.actors)],
    ["classes", Object.keys(project.database.classes)],
  ];
  for (const [table, ids] of entityRefs) {
    if (ids.length > 0) add(1, fc.constantFrom(...ids).map((id) => cmd.deleteEntity(table as "items", id)));
  }

  // システム・アセット・スイッチ
  add(1, withMap((m) => fc.record({ x: fc.integer({ min: 0, max: doc.maps[m]!.width - 1 }), y: fc.integer({ min: 0, max: doc.maps[m]!.height - 1 }) }).map((p) => cmd.setSystem({ startMap: m, startX: p.x, startY: p.y }))));
  add(1, fc.constantFrom<16 | 32 | 48>(16, 32, 48).map((tileSize) => cmd.setSystem({ tileSize })));
  add(1, fc.dictionary(fc.stringMatching(/^[a-z]{1,5}$/), fc.string({ maxLength: 6 }), { maxKeys: 3 }).map((terms) => cmd.setSystem({ terms })));
  add(2, fc.record({ id: suffix, name: fc.string({ maxLength: 6 }) }).map((p) => cmd.setSwitchName(`sw_${p.id}` as SwitchId, p.name)));
  if (switches.length > 0) add(1, fc.constantFrom(...switches).map((id) => cmd.removeSwitch(id as SwitchId)));
  const assetIds = Object.keys(project.assets.entries);
  if (assetIds.length > 0) add(1, fc.constantFrom(...assetIds).map((id) => cmd.unregisterAsset(id as never)));
  add(1, fc.stringMatching(/^[0-9a-f]{16}$/).map((id) => cmd.registerAsset(id as never, { name: "x.png", kind: "image", mime: "image/png", size: 1 })));

  // まとめ
  add(
    1,
    withMap((m) => fc.constant(cmd.batch("まとめ", [cmd.createEvent(m, 0, 0, "ev_batch" as EventId), cmd.paintTiles(m, 0, [{ x: 0, y: 0, tile: 2 }])]))),
  );
  return fc.oneof(...options.map(([weight, arbitrary]) => ({ weight, arbitrary })));
}
