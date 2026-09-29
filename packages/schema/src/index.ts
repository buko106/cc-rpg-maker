/**
 * @rpg/schema — プロジェクトデータ型、バリデーション、マイグレーション。
 *
 * 設計: docs/01-schema.md
 * ゲーム定義（Project / MapData）の唯一の正。型は zod スキーマから導出する。
 */
export * from "./ids.js";
export type { Result } from "./result.js";
export { err, ok } from "./result.js";
export type { SchemaError, SchemaIssue } from "./errors.js";

export * from "./common.js";
export * from "./command.js";
export * from "./map.js";
export * from "./database.js";
export * from "./project.js";

export { migrateMapTo, migrateTo, migrations } from "./migrations.js";
export type { Migration } from "./migrations.js";
export { parseMapData, parseProject, serializeMapData, serializeProject } from "./parse.js";
export { collectRefs, findDanglingRefs } from "./refs.js";
export type { CommandRefResolver, Ref, RefKind, RefTarget } from "./refs.js";

