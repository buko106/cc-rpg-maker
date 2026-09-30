import { err, ok } from "@rpg/schema";
import type { MapData, MapId, RefTarget, Result } from "@rpg/schema";
import type { ProjectDocument } from "@rpg/project-store";
import type { EditError } from "./errors.js";

/**
 * `ProjectDocument` に対する編集操作 1 つ。UI は文書を直接書き換えず、必ずコマンドを `session.execute` に渡す。
 * `apply` は純関数（新しい文書を返し、引数は変えない）。何も変わらないときは引数をそのまま返す。
 */
export interface EditorCommand {
  readonly kind: string;
  /** Undo メニューなどに出す名前 */
  readonly label: string;
  apply(doc: ProjectDocument): Result<ProjectDocument, EditError>;
  /** `apply` の前後の文書から、元に戻すコマンドを作る。 */
  invert(before: ProjectDocument, after: ProjectDocument): EditorCommand;
  /** 直前のコマンドと 1 つにまとめられるなら、まとめたコマンド（`prev` の効果も含む）を返す。 */
  coalesce?(prev: EditorCommand): EditorCommand | undefined;
  /** 書き換えるマップ（自動保存の `changedMaps` に使う）。 */
  touchedMaps(): MapId[];
  /** `project`（マップ以外の定義）を書き換えるか。 */
  touchesProject(): boolean;
  /** このコマンドが削除するもの。適用後もまだ参照されていれば `hasReferences` になる。 */
  removes(): RefTarget[];
}

export interface EditSpec {
  kind: string;
  label: string;
  maps?: readonly MapId[];
  project?: boolean;
  removes?: readonly RefTarget[];
  apply(doc: ProjectDocument): Result<ProjectDocument, EditError>;
  coalesce?(prev: EditorCommand): EditorCommand | undefined;
}

/** 元に戻すためのコマンド。書き換えた範囲（マップ・project）だけを `before` の内容に戻す。 */
function restore(before: ProjectDocument, maps: readonly MapId[], project: boolean, label: string): EditorCommand {
  return {
    kind: "restore",
    label: `${label}を元に戻す`,
    apply(doc) {
      const restored: Record<MapId, MapData> = { ...doc.maps };
      for (const id of maps) {
        const map = Object.hasOwn(before.maps, id) ? before.maps[id] : undefined;
        if (map === undefined) delete restored[id];
        else restored[id] = map;
      }
      return ok({ ...doc, project: project ? before.project : doc.project, maps: restored });
    },
    invert: (_before, after) => restore(after, maps, project, label),
    touchedMaps: () => [...maps],
    touchesProject: () => project,
    removes: () => [],
  };
}

/** コマンドを作る。`invert`（範囲を戻す）は自動で組み立てる。 */
export function defineEdit(spec: EditSpec): EditorCommand {
  const maps = spec.maps ?? [];
  const project = spec.project ?? false;
  const command: EditorCommand = {
    kind: spec.kind,
    label: spec.label,
    apply: spec.apply,
    invert: (before) => restore(before, maps, project, spec.label),
    touchedMaps: () => [...maps],
    touchesProject: () => project,
    removes: () => [...(spec.removes ?? [])],
    ...(spec.coalesce === undefined ? {} : { coalesce: spec.coalesce }),
  };
  return command;
}

/** 複数のコマンドを 1 回の Undo で戻せる 1 つにまとめる。途中で失敗したら全体が失敗する（文書は変わらない）。 */
export function batch(label: string, commands: readonly EditorCommand[]): EditorCommand {
  const list = [...commands];
  return defineEdit({
    kind: "batch",
    label,
    maps: [...new Set(list.flatMap((c) => c.touchedMaps()))],
    project: list.some((c) => c.touchesProject()),
    removes: list.flatMap((c) => c.removes()),
    apply(doc) {
      let current = doc;
      for (const c of list) {
        const r = c.apply(current);
        if (!r.ok) return r;
        current = r.value;
      }
      return ok(current);
    },
  });
}

// ---- コマンド実装の共通部品 ----

export const notFound = (what: string, id: string): EditError => ({ kind: "notFound", message: `${what} ${id} が無い` });
export const invalid = (message: string): EditError => ({ kind: "invalid", message });

export const mapOf = (doc: ProjectDocument, id: MapId): MapData | undefined => (Object.hasOwn(doc.maps, id) ? doc.maps[id] : undefined);

export const withMap = (doc: ProjectDocument, map: MapData): ProjectDocument => ({ ...doc, maps: { ...doc.maps, [map.id]: map } });

/** `Record` の一部を差し替えた新しい Record（`undefined` を渡すと消す）。 */
export function withEntry<R extends object>(table: R, id: string, value: R[keyof R] | undefined): R {
  const next = { ...table } as Record<string, unknown>;
  if (value === undefined) delete next[id];
  else next[id] = value;
  return next as R;
}

export { err, ok };
