import type { z } from "zod";
import type { SchemaError, SchemaIssue } from "./errors.js";
import { err, ok } from "./result.js";
import type { Result } from "./result.js";
import { migrateMapTo, migrateTo } from "./migrations.js";
import { MapDataSchema } from "./map.js";
import type { MapData } from "./map.js";
import { CURRENT_FORMAT_VERSION, ProjectSchema } from "./project.js";
import type { Project } from "./project.js";

function toIssues(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

function validate<T>(schema: z.ZodType<T>, json: unknown): Result<T, SchemaError> {
  const r = schema.safeParse(json);
  return r.success ? ok(r.data) : err({ kind: "invalid", issues: toIssues(r.error) });
}

/**
 * JSON から Project を読む。`formatVersion < CURRENT` なら順次マイグレーションしてから検証する。
 * `formatVersion > CURRENT` は `newer-format` エラー。例外は投げない。
 */
export function parseProject(json: unknown): Result<Project, SchemaError> {
  const version = typeof json === "object" && json !== null ? (json as { formatVersion?: unknown }).formatVersion : undefined;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return err({ kind: "invalid", issues: [{ path: "formatVersion", message: "1 以上の整数の formatVersion が必要" }] });
  }
  if (version > CURRENT_FORMAT_VERSION) {
    return err({ kind: "newer-format", found: version, supported: CURRENT_FORMAT_VERSION });
  }
  const migrated = migrateTo(json, CURRENT_FORMAT_VERSION);
  if (!migrated.ok) return migrated;
  return validate(ProjectSchema, migrated.value);
}

/**
 * JSON から MapData を読む。
 * @param formatVersion その MapData を含むプロジェクトの（マイグレーション前の）`formatVersion`
 */
export function parseMapData(json: unknown, formatVersion: number): Result<MapData, SchemaError> {
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    return err({ kind: "invalid", issues: [{ path: "formatVersion", message: "1 以上の整数が必要" }] });
  }
  if (formatVersion > CURRENT_FORMAT_VERSION) {
    return err({ kind: "newer-format", found: formatVersion, supported: CURRENT_FORMAT_VERSION });
  }
  const migrated = migrateMapTo(json, formatVersion);
  if (!migrated.ok) return migrated;
  return validate(MapDataSchema, migrated.value);
}

/** 型付き配列を配列に、`undefined` を持つキーを落として、JSON 化可能な plain object にする。 */
function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v)));
}

/** JSON 化可能な plain object を返す。`parseProject` の逆変換。 */
export function serializeProject(p: Project): unknown {
  return toPlain(p);
}

/** JSON 化可能な plain object を返す（`Uint16Array` は `number[]` になる）。 */
export function serializeMapData(m: MapData): unknown {
  return toPlain(m);
}
