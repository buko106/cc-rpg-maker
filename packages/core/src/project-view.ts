import type { Actor, ActorId, Class, ClassId, CommonEvent, CommonEventId, Enemy, EnemyId, Item, ItemId, MapData, MapId, Project, Skill, SkillId, Tileset, TilesetId, Troop, TroopId } from "@rpg/schema";

/**
 * Ctx に渡す Project の読み取りビュー。マップ本体は遅延ロードされるので、未ロードなら `map()` は `undefined`
 * を返し、core は `requestMapData` を発行する。
 */
export interface ProjectView {
  readonly project: Project;
  map(id: MapId): MapData | undefined;
  tileset(id: TilesetId): Tileset | undefined;
  actor(id: ActorId): Actor | undefined;
  class(id: ClassId): Class | undefined;
  skill(id: SkillId): Skill | undefined;
  item(id: ItemId): Item | undefined;
  enemy(id: EnemyId): Enemy | undefined;
  troop(id: TroopId): Troop | undefined;
  commonEvent(id: CommonEventId): CommonEvent | undefined;
}

const lookup = <T>(table: Record<string, T>, id: string): T | undefined => (Object.hasOwn(table, id) ? table[id] : undefined);

/**
 * メモリ上の Project とロード済みマップからビューを作る。
 * `maps` は参照のまま保持するので、後からマップを追加すれば（遅延ロードの完了として）以降の `map()` に反映される。
 */
export function createProjectView(project: Project, maps: Record<MapId, MapData> = {}): ProjectView {
  return {
    project,
    map: (id) => lookup(maps, id),
    tileset: (id) => lookup(project.tilesets, id),
    actor: (id) => lookup(project.database.actors, id),
    class: (id) => lookup(project.database.classes, id),
    skill: (id) => lookup(project.database.skills, id),
    item: (id) => lookup(project.database.items, id),
    enemy: (id) => lookup(project.database.enemies, id),
    troop: (id) => lookup(project.database.troops, id),
    commonEvent: (id) => lookup(project.database.commonEvents, id),
  };
}
