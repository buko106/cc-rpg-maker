import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** リポジトリ直下の `fixtures/`。 */
export const FIXTURES_ROOT = resolve(import.meta.dirname, "../../../fixtures");

export function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, relativePath), "utf8"));
}

/** ディスク上の形（フォルダ形式）のままの、未検証のプロジェクト。 */
export interface RawProjectFixture {
  name: string;
  formatVersion: number;
  project: unknown;
  /** ファイル名（拡張子なし）→ MapData の JSON。 */
  maps: Record<string, unknown>;
}

/** `fixtures/projects/v{version}/` にあるフィクスチャ名の一覧。 */
export function listProjectFixtures(version: number): string[] {
  return readdirSync(join(FIXTURES_ROOT, "projects", `v${version}`), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** `fixtures/projects/v{version}/{name}/{project.json, maps/*.json}` を読む。 */
export function loadRawProject(name: string, version = 1): RawProjectFixture {
  const base = `projects/v${version}/${name}`;
  const maps: Record<string, unknown> = {};
  for (const file of readdirSync(join(FIXTURES_ROOT, base, "maps")).sort()) {
    if (file.endsWith(".json")) maps[file.slice(0, -".json".length)] = readJson(`${base}/maps/${file}`);
  }
  return { name, formatVersion: version, project: readJson(`${base}/project.json`), maps };
}
