import fc from "fast-check";
import type { EventCommand, EventPage, MapData, MapEvent, Project } from "@rpg/schema";

/**
 * `@rpg/schema` の型に対する fast-check arbitrary。
 * 生成物は常にスキーマ上 valid（キーと id の一致、tiles の長さ、位置がマップ内、など）。
 * JSON ラウンドトリップで値が変わらないよう、`-0` や `NaN` は生成しない。
 */

const idOf = (prefix: string): fc.Arbitrary<string> => fc.stringMatching(/^[a-z0-9]{1,8}$/).map((s) => `${prefix}_${s}`);
const ids = (prefix: string, maxLength: number): fc.Arbitrary<string[]> =>
  fc.uniqueArray(idOf(prefix), { maxLength });

const smallInt = fc.integer({ min: 0, max: 100 });
const ratio = fc.integer({ min: 0, max: 100 }).map((n) => n / 100);
const text = fc.string({ maxLength: 12 });
const assetIdArb = fc.stringMatching(/^[0-9a-f]{16}$/);
const isoDate = fc.date({ min: new Date("2000-01-01"), max: new Date("2100-01-01") }).map((d) => d.toISOString());

const jsonLeaf = fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean(), fc.constant(null));
const jsonValue: fc.Arbitrary<unknown> = fc.oneof(jsonLeaf, fc.array(jsonLeaf, { maxLength: 3 }));

/** 任意の `code` / `params` を持つコマンド。`schema` は中身を検証しない。 */
export const eventCommandArb: fc.Arbitrary<EventCommand> = fc.record({
  code: fc.constantFrom("ShowText", "ControlSwitches", "Wait", "plugin:demo/Custom"),
  params: fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), jsonValue, { maxKeys: 3 }),
  indent: fc.integer({ min: 0, max: 3 }),
});

const directionArb = fc.constantFrom("up", "down", "left", "right" as const);

function eventPageArb(refs: { switches: string[]; variables: string[] }): fc.Arbitrary<EventPage> {
  const conditions: fc.Arbitrary<EventPage["conditions"][number]>[] = [
    fc.record({ kind: fc.constant("selfSwitch" as const), key: fc.constantFrom("A", "B", "C", "D" as const), value: fc.boolean() }),
  ];
  if (refs.switches.length > 0) {
    conditions.push(fc.record({ kind: fc.constant("switch" as const), id: fc.constantFrom(...refs.switches), value: fc.boolean() }) as never);
  }
  if (refs.variables.length > 0) {
    conditions.push(
      fc.record({
        kind: fc.constant("variable" as const),
        id: fc.constantFrom(...refs.variables),
        op: fc.constantFrom(">=", "==", "<=" as const),
        value: smallInt,
      }) as never,
    );
  }
  return fc.record(
    {
      conditions: fc.array(fc.oneof(...conditions), { maxLength: 3 }),
      graphic: fc.record({ asset: assetIdArb, index: smallInt, direction: directionArb }),
      trigger: fc.constantFrom("action", "touch", "autorun", "parallel" as const),
      through: fc.boolean(),
      priority: fc.constantFrom("below", "same", "above" as const),
      moveRoute: fc.record({
        repeat: fc.boolean(),
        skippable: fc.boolean(),
        steps: fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("move" as const), dir: fc.constantFrom("up", "down", "random", "toward" as const) }),
            fc.record({ kind: fc.constant("wait" as const), frames: smallInt }),
          ),
          { maxLength: 3 },
        ),
      }),
      commands: fc.array(eventCommandArb, { maxLength: 4 }),
    },
    { requiredKeys: ["conditions", "trigger", "through", "priority", "commands"] },
  ) as fc.Arbitrary<EventPage>;
}

export interface MapDataArbOptions {
  id?: string;
  tileset?: string;
  switches?: string[];
  variables?: string[];
}

/** 妥当な MapData（`id` キーの一致、`layers[i].tiles.length === width*height`、イベントがマップ内）。 */
export function mapDataArb(options: MapDataArbOptions = {}): fc.Arbitrary<MapData> {
  const refs = { switches: options.switches ?? [], variables: options.variables ?? [] };
  return fc
    .record({
      id: options.id === undefined ? idOf("map") : fc.constant(options.id),
      width: fc.integer({ min: 1, max: 6 }),
      height: fc.integer({ min: 1, max: 6 }),
      tileset: options.tileset === undefined ? idOf("ts") : fc.constant(options.tileset),
      layerCount: fc.integer({ min: 1, max: 3 }),
      eventIds: ids("ev", 3),
    })
    .chain(({ id, width, height, tileset, layerCount, eventIds }) => {
      const tiles = fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: width * height, maxLength: width * height });
      const event = (eid: string): fc.Arbitrary<MapEvent> =>
        fc.record({
          id: fc.constant(eid) as fc.Arbitrary<never>,
          name: text,
          x: fc.integer({ min: 0, max: width - 1 }),
          y: fc.integer({ min: 0, max: height - 1 }),
          pages: fc.array(eventPageArb(refs), { maxLength: 2 }),
        });
      return fc.record({
        id: fc.constant(id) as fc.Arbitrary<never>,
        width: fc.constant(width),
        height: fc.constant(height),
        tileset: fc.constant(tileset) as fc.Arbitrary<never>,
        layers: fc.array(fc.record({ name: text, tiles }), { minLength: layerCount, maxLength: layerCount }),
        events: fc.tuple(...eventIds.map(event)).map((evs) => Object.fromEntries(evs.map((e) => [e.id, e]))),
      });
    }) as fc.Arbitrary<MapData>;
}

const audioRefArb = fc.record({ asset: assetIdArb, volume: ratio, pitch: fc.integer({ min: 1, max: 40 }).map((n) => n / 10), loop: fc.boolean() });

/** 妥当な Project（テーブルのキーと id の一致を保つ）。マップ本体は含まない。 */
export const projectArb: fc.Arbitrary<Project> = fc
  .record({
    mapIds: ids("map", 3),
    tilesetIds: ids("ts", 2),
    actorIds: ids("actor", 3),
    classIds: ids("class", 2),
    skillIds: ids("skill", 2),
    itemIds: ids("item", 2),
    enemyIds: ids("enemy", 2),
    switchIds: ids("sw", 3),
    variableIds: ids("var", 3),
  })
  .chain((t) => {
    const table = <T extends { id: string }>(idList: string[], make: (id: string) => fc.Arbitrary<T>): fc.Arbitrary<Record<string, T>> =>
      fc.tuple(...idList.map(make)).map((items) => Object.fromEntries(items.map((i) => [i.id, i])));
    const nameOnly = (idList: string[]): fc.Arbitrary<Record<string, { name: string }>> =>
      fc.tuple(...idList.map(() => fc.record({ name: text }))).map((items) => Object.fromEntries(idList.map((id, i) => [id, items[i]!])));
    const pick = (list: string[]): fc.Arbitrary<string> => (list.length > 0 ? fc.constantFrom(...list) : fc.constant("missing_ref"));
    const curve = fc.record(
      Object.fromEntries(["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"].map((p) => [p, fc.record({ base: smallInt, growth: smallInt })])),
    );
    const params = fc.record(Object.fromEntries(["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"].map((p) => [p, smallInt])));

    return fc.record({
      formatVersion: fc.constant(1),
      meta: fc.record({ id: idOf("proj"), title: text, createdAt: isoDate, updatedAt: isoDate }),
      system: fc.record({
        startMap: pick(t.mapIds),
        startX: smallInt,
        startY: smallInt,
        initialParty: fc.subarray(t.actorIds),
        tileSize: fc.constantFrom(16, 32, 48 as const),
        screen: fc.record({ width: fc.integer({ min: 1, max: 1920 }), height: fc.integer({ min: 1, max: 1080 }) }),
        bgm: fc.record({ title: audioRefArb, battle: audioRefArb }, { requiredKeys: [] }),
        terms: fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), text, { maxKeys: 3 }),
      }),
      maps: table(t.mapIds, (id) => fc.record({ id: fc.constant(id), name: text, order: fc.integer({ min: -5, max: 5 }) })),
      tilesets: table(t.tilesetIds, (id) =>
        fc.record({ id: fc.constant(id), name: text, passage: fc.array(fc.integer({ min: 0, max: 15 }), { maxLength: 8 }) }),
      ),
      database: fc.record({
        actors: table(t.actorIds, (id) =>
          fc.record({
            id: fc.constant(id),
            name: text,
            classId: pick(t.classIds),
            initialLevel: fc.integer({ min: 1, max: 99 }),
            equips: fc.record({ weapon: pick(t.itemIds) }, { requiredKeys: [] }),
          }),
        ),
        classes: table(t.classIds, (id) =>
          fc.record({
            id: fc.constant(id),
            name: text,
            params: curve,
            skills: fc.array(fc.record({ level: fc.integer({ min: 1, max: 99 }), skill: pick(t.skillIds) }), { maxLength: 2 }),
          }),
        ),
        skills: table(t.skillIds, (id) =>
          fc.record({
            id: fc.constant(id),
            name: text,
            mpCost: smallInt,
            scope: fc.constantFrom("none", "self", "one-enemy", "all-enemies", "one-ally" as const),
            formula: fc.constantFrom("a.atk * 4 - b.def * 2", "10", "a.mat * 2"),
            effects: fc.array(fc.record({ kind: fc.constant("recoverHp" as const), value: smallInt }), { maxLength: 2 }),
          }),
        ),
        items: table(t.itemIds, (id) =>
          fc.record({
            id: fc.constant(id),
            name: text,
            kind: fc.constantFrom("consumable", "weapon", "armor", "key" as const),
            price: smallInt,
            effects: fc.array(fc.record({ kind: fc.constant("recoverMp" as const), value: smallInt }), { maxLength: 2 }),
          }),
        ),
        enemies: table(t.enemyIds, (id) =>
          fc.record({
            id: fc.constant(id),
            name: text,
            params,
            actions: fc.array(fc.record({ skill: pick(t.skillIds), rating: fc.integer({ min: 1, max: 9 }) }), { maxLength: 2 }),
            drops: fc.array(fc.record({ item: pick(t.itemIds), rate: ratio }), { maxLength: 2 }),
            exp: smallInt,
            gold: smallInt,
          }),
        ),
        troops: fc.constant({}),
        commonEvents: fc.constant({}),
      }),
      assets: fc.dictionary(assetIdArb, fc.record({ name: text, kind: fc.constantFrom("image", "audio", "font", "data" as const), mime: fc.constant("image/png"), size: smallInt }), {
        maxKeys: 3,
      }).map((entries) => ({ entries })),
      switches: nameOnly(t.switchIds),
      variables: nameOnly(t.variableIds),
    });
  }) as fc.Arbitrary<Project>;
