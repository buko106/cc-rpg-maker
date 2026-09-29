# 12. `@rpg/editor-core` — EditorCommand・Undo/Redo・整合性チェック

## 責務
- `ProjectDocument` に対する**すべての編集操作**を `EditorCommand` として定義する。
- Undo/Redo スタック。
- 選択状態・表示状態（現在のマップ、レイヤ、ツール）などの**エディタセッション状態**。
- 参照整合性チェックと警告（削除前の影響範囲表示）。
- 自動保存ポリシー（デバウンス、`changedMaps` 追跡）。
- テストプレイ用の `ProjectSource` 生成（メモリ上の文書を `runtime` へ渡す）。

## 非責務
- UI コンポーネント。→ 13
- 永続化の実装。→ 10（ポート経由で利用）

## 依存が許されるパッケージ
`@rpg/schema`, `@rpg/project-store`（ポート型のみ）, `@rpg/core`（`CommandRegistry` のメタデータ参照のみ）。`DOM` を含めない。

## 公開インターフェース

### EditorCommand
```ts
export interface EditorCommand {
  readonly kind: string;
  readonly label: string;                                // Undo メニュー表示用
  apply(doc: ProjectDocument): Result<ProjectDocument, EditError>;
  invert(before: ProjectDocument, after: ProjectDocument): EditorCommand;   // Undo 用
  /** 直前のコマンドとマージできるか（連続タイル描画など）。マージ後を返す */
  coalesce?(prev: EditorCommand): EditorCommand | undefined;
  touchedMaps(): MapId[];                                // 自動保存の changedMaps 用
}
```

### コマンドファクトリ（抜粋）
```ts
export const cmd = {
  // マップ
  paintTiles(mapId, layer, cells: { x; y; tile }[]): EditorCommand;
  fillTiles(mapId, layer, x, y, tile): EditorCommand;
  resizeMap(mapId, width, height, anchor): EditorCommand;
  createMap(meta: Omit<MapMeta,"id">, data: Partial<MapData>): EditorCommand;
  deleteMap(mapId): EditorCommand;
  // イベント
  createEvent(mapId, x, y): EditorCommand;  moveEvent(mapId, eventId, x, y): EditorCommand;  deleteEvent(mapId, eventId): EditorCommand;
  setEventPage(mapId, eventId, pageIndex, page: EventPage): EditorCommand;
  insertCommands(mapId, eventId, pageIndex, at: number, commands: EventCommand[]): EditorCommand;
  removeCommands(mapId, eventId, pageIndex, at: number, count: number): EditorCommand;
  replaceCommand(mapId, eventId, pageIndex, at: number, command: EventCommand): EditorCommand;
  // データベース
  upsertEntity<K extends keyof Database>(table: K, entity: Database[K][string]): EditorCommand;
  deleteEntity<K extends keyof Database>(table: K, id: string): EditorCommand;
  // システム・アセット
  setSystem(patch: Partial<SystemSettings>): EditorCommand;
  registerAsset(entry): EditorCommand;  unregisterAsset(id): EditorCommand;
  setSwitchName(id, name): EditorCommand;  setVariableName(id, name): EditorCommand;
  batch(label: string, commands: EditorCommand[]): EditorCommand;   // 1回の Undo で戻る
};
```

### EditorSession
```ts
export interface EditorSession {
  readonly doc: ProjectDocument;
  readonly ui: EditorUiState;         // { currentMap, currentLayer, tool, selection, zoom }
  readonly dirty: boolean;
  readonly canUndo: boolean; readonly canRedo: boolean;

  execute(c: EditorCommand): Result<void, EditError>;
  undo(): void; redo(): void;
  setUi(patch: Partial<EditorUiState>): void;
  subscribe(listener: (s: EditorSession) => void): () => void;

  validate(): Diagnostic[];                                     // 参照切れ・未使用アセット等
  impactOf(target: RefTarget): { from: string; description: string }[];   // 削除前の影響範囲
  save(): Promise<Result<void, ProjectStoreError>>;
  projectSource(): ProjectSource;                               // テストプレイ用（06）
}

export function createEditorSession(deps: {
  repo: ProjectRepository; doc: ProjectDocument; commands: CommandRegistry;
  autosave?: { debounceMs: number };
}): EditorSession;

export interface Diagnostic { severity: "error" | "warning"; code: string; message: string; target?: RefTarget; location?: { mapId?; eventId?; page?; commandIndex? } }
```

## 実装指針
- `doc` は不変。`apply` は新しい `ProjectDocument` を返す（`immer` 可）。
- Undo スタックは `{ command, inverse }` の組。上限 200。`coalesce` 対象は 500ms 以内の同種コマンドのみ。
- `execute` は `apply` 後に**軽量検証**（`schema` の該当部分の zod parse）を行い、失敗したら状態を変えず `EditError` を返す。
- `validate()` は `schema.findDanglingRefs` に `CommandRegistry.get(code).meta.refs` を注入して実行。
- `deleteEntity` / `deleteMap` は `impactOf` の結果を `EditError.kind === "hasReferences"` として返し、`{ force: true }` で強制可能とする（UI が確認ダイアログを出す）。
- 自動保存：`dirty` になってから `debounceMs` 後に `repo.save(doc, { changedMaps, expectedRevision })`。`conflict` は `subscribe` 経由で UI に通知。

## 不変条件
1. `execute(c); undo()` で `doc` が実行前と deep-equal。
2. `execute(c); undo(); redo()` で `doc` が `execute` 直後と deep-equal。
3. `execute` が `Err` を返したとき `doc` は変化しない。
4. 任意のコマンド列適用後に `validate()` が `severity: "error"` を返さない（コマンドが整合性を壊さない）。※ `force` 削除を除く。
5. `batch` は 1 回の `undo` で全部戻る。

## テスト要件
- 全コマンドファクトリに対し apply/invert のラウンドトリップテスト。
- fast-check：`test-utils/arbitraries/editorCommands.ts` で合法なコマンド列を生成し、不変条件 1・2・4 を検証。
- `coalesce`：連続 `paintTiles` が 1 つの Undo 単位にまとまる。
- `impactOf`：アクターを参照するイベント・パーティ設定が列挙される。
- 自動保存：フェイクタイマーでデバウンスと `conflict` 通知。

## 完了条件
- 上記テストが通り、13 が本パッケージだけを使って UI を組める。
