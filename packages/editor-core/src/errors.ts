import type { RefTarget, SchemaIssue } from "@rpg/schema";

/** 参照している側（削除前の影響範囲の 1 行）。 */
export interface Impact {
  /** 参照元。`map:m1/event:e1/page:0/command:2`、`database.actors.a1` のような形。 */
  from: string;
  /** 人が読める説明 */
  description: string;
}

/** 編集の失敗。`message` はそのまま UI に出せる文言。 */
export type EditError =
  | { kind: "notFound"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "duplicate"; message: string }
  /** 削除しようとしたものが、まだ参照されている。`execute(c, { force: true })` で強制できる。 */
  | { kind: "hasReferences"; message: string; references: Impact[] }
  /** 適用結果がスキーマに合わない（軽量検証で検出）。 */
  | { kind: "schema"; message: string; issues: SchemaIssue[] };

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  target?: RefTarget;
  location?: { mapId?: string; eventId?: string; page?: number; commandIndex?: number };
}
