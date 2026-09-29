import { CURRENT_FORMAT_VERSION } from "./project.js";
import type { SchemaError } from "./errors.js";
import { err, ok } from "./result.js";
import type { Result } from "./result.js";

export interface Migration {
  /** `to === from + 1` */
  from: number;
  to: number;
  migrateProject(p: unknown): unknown;
  migrateMap(m: unknown): unknown;
}

/**
 * 登録済みのマイグレーション。`from` の昇順に、途切れなく並べる。
 * フォーマットを変えるときは `CURRENT_FORMAT_VERSION` を上げてここに追加する（docs/00-principles.md §6）。
 * フォーマット v1 が最初なので、現時点では空。
 */
export const migrations: readonly Migration[] = [];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function applyMigrations(
  json: unknown,
  from: number,
  target: number,
  pick: (m: Migration) => (x: unknown) => unknown,
  registry: readonly Migration[],
): Result<unknown, SchemaError> {
  if (target < from) return err({ kind: "migration", message: `ダウングレードは未対応（v${from} → v${target}）` });
  let current = json;
  for (let v = from; v < target; v++) {
    const m = registry.find((x) => x.from === v);
    if (m === undefined) return err({ kind: "migration", message: `v${v} → v${v + 1} のマイグレーションが無い` });
    current = pick(m)(current);
  }
  return ok(current);
}

/**
 * Project の JSON を `target` バージョンまで順次マイグレーションする。スキーマ検証はしない。
 * 結果の `formatVersion` は `target` になる。
 * @param registry テスト用に差し替え可能。既定は `migrations`。
 */
export function migrateTo(json: unknown, target: number, registry: readonly Migration[] = migrations): Result<unknown, SchemaError> {
  if (!isRecord(json) || typeof json["formatVersion"] !== "number" || !Number.isInteger(json["formatVersion"])) {
    return err({ kind: "invalid", issues: [{ path: "formatVersion", message: "整数の formatVersion が必要" }] });
  }
  const from = json["formatVersion"];
  const migrated = applyMigrations(json, from, target, (m) => (x) => m.migrateProject(x), registry);
  if (!migrated.ok) return migrated;
  return ok(isRecord(migrated.value) ? { ...migrated.value, formatVersion: target } : migrated.value);
}

/** MapData の JSON を、プロジェクトの `formatVersion`（`from`）から `target` までマイグレーションする。 */
export function migrateMapTo(
  json: unknown,
  from: number,
  target: number = CURRENT_FORMAT_VERSION,
  registry: readonly Migration[] = migrations,
): Result<unknown, SchemaError> {
  return applyMigrations(json, from, target, (m) => (x) => m.migrateMap(x), registry);
}
