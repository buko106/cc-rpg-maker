import { parseMapData, parseProject } from "@rpg/schema";
import type { MapData, MapId, Project } from "@rpg/schema";
import { createCtx, createProjectView } from "@rpg/core";
import type { Ctx, ProjectView } from "@rpg/core";
import { loadRawProject } from "../fixtures.js";

export interface LoadedProject {
  project: Project;
  maps: Record<MapId, MapData>;
  view: ProjectView;
  ctx: Ctx;
}

/**
 * `fixtures/projects/v{version}/{name}` を読み込み、検証して、Ctx（組み込みコマンド登録済み）まで組み立てる。
 * フィクスチャが不正ならテストの前提が壊れているので例外を投げる。
 * `maps` は `view` が参照しているので、後からマップを削除・追加して遅延ロードを再現できる。
 */
export function loadFixtureProject(name: string, version = 1): LoadedProject {
  const raw = loadRawProject(name, version);
  const project = parseProject(raw.project);
  if (!project.ok) throw new Error(`fixture ${name}: project.json が不正: ${JSON.stringify(project.error)}`);
  const maps: Record<MapId, MapData> = {};
  for (const [file, json] of Object.entries(raw.maps)) {
    const map = parseMapData(json, raw.formatVersion);
    if (!map.ok) throw new Error(`fixture ${name}: maps/${file}.json が不正: ${JSON.stringify(map.error)}`);
    maps[map.value.id] = map.value;
  }
  const view = createProjectView(project.value, maps);
  return { project: project.value, maps, view, ctx: createCtx(view) };
}
