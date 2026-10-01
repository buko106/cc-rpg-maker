import type { Database, RefKind, SystemSettings, Tileset, TilesetId } from "@rpg/schema";
import type { AssetEntry, AssetId, SwitchId, VariableId } from "@rpg/schema";
import { defineEdit, err, invalid, notFound, ok, withEntry } from "../command.js";
import type { EditorCommand } from "../command.js";

/** データベースのテーブル名 → 参照の種類。 */
export const TABLE_KIND: { readonly [K in keyof Database]: RefKind } = {
  actors: "actor",
  classes: "class",
  skills: "skill",
  items: "item",
  enemies: "enemy",
  troops: "troop",
  states: "state",
  commonEvents: "commonEvent",
};

const TABLE_LABEL: { readonly [K in keyof Database]: string } = {
  actors: "アクター",
  classes: "職業",
  skills: "スキル",
  items: "アイテム",
  enemies: "敵",
  troops: "敵グループ",
  states: "ステート",
  commonEvents: "コモンイベント",
};

/** テーブル `K` の 1 件分。 */
export type Entity<K extends keyof Database> = Database[K][keyof Database[K]];

interface UpsertCommand extends EditorCommand {
  readonly table: string;
  readonly entityId: string;
}

/** データベースのエンティティを追加または置き換える。同じエンティティへの連続した更新（入力中など）は 1 つにまとまる。 */
export function upsertEntity<K extends keyof Database>(table: K, entity: Entity<K>): EditorCommand {
  const entityId = (entity as { id: string }).id;
  const base = defineEdit({
    kind: "upsertEntity",
    label: `${TABLE_LABEL[table]}の編集`,
    project: true,
    apply(doc) {
      const records = doc.project.database[table] as Record<string, unknown>;
      if (Object.hasOwn(records, entityId) && records[entityId] === entity) return ok(doc);
      const next = withEntry(records, entityId, entity as unknown);
      return ok({ ...doc, project: { ...doc.project, database: { ...doc.project.database, [table]: next } } });
    },
    coalesce: (prev) => {
      const p = prev as UpsertCommand;
      return prev.kind === "upsertEntity" && p.table === table && p.entityId === entityId ? upsertEntity(table, entity) : undefined;
    },
  });
  return Object.assign(base, { table, entityId }) as UpsertCommand;
}

/** エンティティを削除する。参照が残っていれば `hasReferences`。 */
export function deleteEntity<K extends keyof Database>(table: K, id: string): EditorCommand {
  return defineEdit({
    kind: "deleteEntity",
    label: `${TABLE_LABEL[table]}の削除`,
    project: true,
    removes: [{ kind: TABLE_KIND[table], id }],
    apply(doc) {
      const records = doc.project.database[table] as Record<string, unknown>;
      if (!Object.hasOwn(records, id)) return err(notFound(TABLE_LABEL[table], id));
      return ok({ ...doc, project: { ...doc.project, database: { ...doc.project.database, [table]: withEntry(records, id, undefined) } } });
    },
  });
}

const sameKeys = (a: object, b: object): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};

/** システム設定の一部を変える。同じ項目への連続した変更は 1 つにまとまる。 */
export function setSystem(patch: Partial<SystemSettings>): EditorCommand {
  const base = defineEdit({
    kind: "setSystem",
    label: "システム設定の変更",
    project: true,
    apply: (doc) => ok({ ...doc, project: { ...doc.project, system: { ...doc.project.system, ...patch } } }),
    coalesce: (prev) => {
      const p = prev as unknown as { patch?: Partial<SystemSettings> };
      return prev.kind === "setSystem" && p.patch !== undefined && sameKeys(p.patch, patch) ? setSystem(patch) : undefined;
    },
  });
  return Object.assign(base, { patch });
}

/** アセットをマニフェストに登録する（バイト列の保存は `ProjectAssetStore.put`）。同じ ID の登録は置き換え。 */
export function registerAsset(id: AssetId, entry: AssetEntry): EditorCommand {
  return defineEdit({
    kind: "registerAsset",
    label: "アセットの登録",
    project: true,
    apply(doc) {
      const entries = withEntry(doc.project.assets.entries, id, entry);
      return ok({ ...doc, project: { ...doc.project, assets: { ...doc.project.assets, entries } } });
    },
  });
}

/** アセットの登録を外す。使われていれば `hasReferences`。 */
export function unregisterAsset(id: AssetId): EditorCommand {
  return defineEdit({
    kind: "unregisterAsset",
    label: "アセットの登録解除",
    project: true,
    removes: [{ kind: "asset", id }],
    apply(doc) {
      if (!Object.hasOwn(doc.project.assets.entries, id)) return err(notFound("アセット", id));
      const entries = withEntry(doc.project.assets.entries, id, undefined);
      return ok({ ...doc, project: { ...doc.project, assets: { ...doc.project.assets, entries } } });
    },
  });
}

type NamedTable = "switches" | "variables";

function setName(table: NamedTable, id: string, name: string): EditorCommand {
  const label = table === "switches" ? "スイッチ" : "変数";
  return defineEdit({
    kind: table === "switches" ? "setSwitchName" : "setVariableName",
    label: `${label}名の変更`,
    project: true,
    apply(doc) {
      const records = doc.project[table] as Record<string, { name: string }>;
      return ok({ ...doc, project: { ...doc.project, [table]: withEntry(records, id, { name }) } });
    },
  });
}

function removeNamed(table: NamedTable, id: string): EditorCommand {
  const label = table === "switches" ? "スイッチ" : "変数";
  return defineEdit({
    kind: table === "switches" ? "removeSwitch" : "removeVariable",
    label: `${label}の削除`,
    project: true,
    removes: [{ kind: table === "switches" ? "switch" : "variable", id }],
    apply(doc) {
      if (!Object.hasOwn(doc.project[table], id)) return err(notFound(label, id));
      return ok({ ...doc, project: { ...doc.project, [table]: withEntry(doc.project[table] as Record<string, { name: string }>, id, undefined) } });
    },
  });
}

/** スイッチの名前を付ける（無ければ追加）。 */
export const setSwitchName = (id: SwitchId, name: string): EditorCommand => setName("switches", id, name);
export const setVariableName = (id: VariableId, name: string): EditorCommand => setName("variables", id, name);
export const removeSwitch = (id: SwitchId): EditorCommand => removeNamed("switches", id);
export const removeVariable = (id: VariableId): EditorCommand => removeNamed("variables", id);

/** タイルセットを追加または置き換える。 */
export function upsertTileset(tileset: Tileset): EditorCommand {
  return defineEdit({
    kind: "upsertTileset",
    label: "タイルセットの編集",
    project: true,
    apply: (doc) => (tileset.passage.some((v) => !Number.isInteger(v) || v < 0 || v > 15) ? err(invalid("通行設定は 0〜15 の整数")) : tileset.ice?.some((v) => !Number.isInteger(v) || v < 1) ? err(invalid("氷のタイルは 1 以上の整数")) : ok({ ...doc, project: { ...doc.project, tilesets: withEntry(doc.project.tilesets, tileset.id, tileset) } })),
  });
}

/** タイルセットを削除する。使うマップがあれば `hasReferences`。 */
export function deleteTileset(id: TilesetId): EditorCommand {
  return defineEdit({
    kind: "deleteTileset",
    label: "タイルセットの削除",
    project: true,
    removes: [{ kind: "tileset", id }],
    apply(doc) {
      if (!Object.hasOwn(doc.project.tilesets, id)) return err(notFound("タイルセット", id));
      return ok({ ...doc, project: { ...doc.project, tilesets: withEntry(doc.project.tilesets, id, undefined) } });
    },
  });
}
