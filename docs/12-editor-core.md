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
  createEvent(mapId, x, y): EditorCommand;  pasteEvent(mapId, source: MapEvent, x, y): EditorCommand;  moveEvent(mapId, eventId, x, y): EditorCommand;  deleteEvent(mapId, eventId): EditorCommand;
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
  readonly ui: EditorUiState;         // { currentMap, currentLayer, tool, tile, selection, zoom, clipboard, recentCommands }
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

## 実装メモ（M5 で確定した点）
- **依存**：`editor-core` は `schema` / `project-store`（ポート型）に加えて `core`（`CommandRegistry` のメタデータだけ）に依存する（00 の表と依存ルールを更新）。`runtime` には依存しないので、テストプレイ用の `projectSource()` は同じ形の構造的な型 `DocProjectSource` を返し、`projectMapForEditor` は 13 の側（`editor-ui`）に置いた。
- **コマンド**：`cmd.*` はすべて `defineEdit` で作り、`invert` は「書き換えた範囲（マップ・project）を実行前の内容に戻す」コマンドが自動で作られる。`EditorCommand` には `touchesProject()` と `removes()` を足した。追加したファクトリ：`setMapMeta` / `setMapProperties` / `setEventName` / `removeEventPage` / `removeSwitch` / `removeVariable` / `upsertTileset` / `deleteTileset`。`registerAsset(id, entry)` は ID も取る。`createMap` / `createEvent` は ID を引数で受け取れる（省略時は `newId`）ので、Redo は同じ ID になる。
- **削除と参照**：`removes()` が挙げた対象を、適用後の文書がまだ参照していれば `execute` は `hasReferences`（参照元の一覧つき）を返す。`execute(c, { force: true })` で強制。適用「後」で見るので、参照元と一緒に消す `batch` は通る。
- **軽量検証**：`execute` は `apply` の後、書き換えた部分だけを `ProjectSchema` / `MapDataSchema` で検証し、通らなければ `schema` エラーで文書を変えない。何も変えないコマンド（`apply` が引数をそのまま返す）は履歴にも積まず dirty にもしない。
- **まとめ（coalesce）**：直前の `execute` から 500ms 以内で、同じ対象への `paintTiles` / `moveEvent` / `setEventName` / `setEventPage` / `replaceCommand` / `upsertEntity` / `setSystem`（同じキー集合）は 1 回の Undo になる。Undo / Redo をはさむとまとめない。履歴は 200 件まで。
- **`EditorSession` の追加**：`version`（変更のたびに増える。UI が購読する値）、`undoLabel` / `redoLabel`、`saveStatus`（`idle` / `saving` / `saved` / `error` / `conflict`）、`importAsset`（バイト列の保存とマニフェスト登録を 1 回の Undo にする）、`assetStore()`、`dispose()`。`save({ overwrite: true })` は競合していても上書きする。保存は直列化し、保存中に入った編集は次の保存に回す（マップごとの編集番号で `changedMaps` を管理）。競合中は自動保存を止める。`validate()` の診断は、参照切れ・不明なコマンド・不正なパラメータ・開始位置・未使用アセット・初期パーティが空、プラグインのコマンド（警告）。
- **性質テスト**：`test-utils` の `editorCommandArb(doc)` が、文書の中身を見て合法なコマンド（一部は失敗するもの）を生成する。不変条件 1・2・3・4 と「全部 Undo → 全部 Redo」「保存 → 読み込みで一致」を `fast-check`（`fc.gen`）で確かめる。フィルタで詰まらないよう、選択肢は先に絞ってから `constantFrom` する。

## 実装メモ（イベントのコピー＆ペースト）
- **`cmd.pasteEvent(mapId, source, x, y, id?)`**：`source`（`MapEvent`）を JSON として複製し、新しい ID（省略時は採番）で `(x, y)` に置く。名前とページはそのまま。別のマップにも貼れる。範囲外は `invalid`、ID の重複と**そのセルに別のイベントがある**ときは `duplicate`（重なるとクリックで選べなくなるため。`createEvent` / `moveEvent` は今のところ重なりを許すが、貼り付けだけは断る）。
- **クリップボードは `EditorUiState.clipboard`**：コピー時点のイベントのスナップショット（文書には保存しない。Undo の対象でもない）。元のイベントを後で編集・削除しても貼れる中身は変わらない。切り取りは「`clipboard` に入れる + `deleteEvent`」。OS のクリップボードは使わない（別のプロジェクト・別のタブへは貼れない）。

## 実装メモ（イベント入力の手間を減らす）
- **`execute(c, { groupWithNext: true })`**：「次の編集の下準備」。直後（`COALESCE_MS` 以内、間に Undo / Redo をはさまない）に実行した編集と 1 回の Undo にまとめる（履歴のエントリは `batch([下準備, 次の編集])`、元に戻すは逆順）。続く編集が無ければ単独の Undo のまま。まとめるのは 1 回だけで、`coalesce` よりも優先する。エディタは、フォームの中でスイッチ・変数をその場で作ってそのまま選ぶときに使う（13）。
- **`EditorUiState.recentCommands`**：最近追加したイベントコマンドの code（新しい順・重複なし・`RECENT_COMMANDS_LIMIT` = 6 件。`withRecentCommand`）。文書には保存しない。
