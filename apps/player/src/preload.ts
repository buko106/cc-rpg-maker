import type { AssetId, MapData, Project } from "@rpg/schema";

/**
 * ゲーム開始前に読み込んでおくアセット：タイルセット画像、アクターの歩行・顔グラフィック、開始マップのイベントの絵。
 * マニフェストに無い ID は含めない（`Renderer` が遅延ロードに失敗して描かないだけで済む）。
 */
export function collectStartAssets(project: Project, startMap: MapData): AssetId[] {
  const ids = new Set<AssetId>();
  for (const tileset of Object.values(project.tilesets)) if (tileset.image) ids.add(tileset.image.asset);
  for (const actor of Object.values(project.database.actors)) {
    if (actor.walk) ids.add(actor.walk.asset);
    if (actor.face) ids.add(actor.face.asset);
  }
  for (const event of Object.values(startMap.events)) {
    for (const page of event.pages) if (page.graphic) ids.add(page.graphic.asset);
  }
  return [...ids].filter((id) => Object.hasOwn(project.assets.entries, id)).sort();
}
