# 02. `@rpg/core` — GameState・Action・Reducer・ポート・Snapshot

`@rpg/core` は 02〜05 の4ドキュメントで構成される。本ドキュメントは状態モデルと共通基盤を扱う。

## 責務
- プレイ中の全状態 `GameState` の定義。
- 状態遷移 `tick` / `dispatch` の純粋関数。
- `Random` / `Clock` ポートの定義。
- `GameState ⇄ SaveSnapshot` の変換。
- マップ上の移動・衝突・イベント起動判定。

## 非責務
- 描画・音・入力デバイス。→ `runtime` / adapters
- イベントコマンドの個別意味論。→ 03
- 戦闘の解決。→ 04
- 式評価。→ 05

## 依存が許されるパッケージ
`@rpg/schema` のみ。`tsconfig.lib` に `DOM` を含めない。

## 公開インターフェース

### ポート
```ts
export interface Random {
  next(): number;                       // [0,1)
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(xs: readonly T[]): T;
  fork(label: string): Random;          // 独立ストリーム（戦闘用など）
  readonly seed: string;                // 直列化可能
  serialize(): RandomState; }
export function createRandom(seed: string): Random;              // xoshiro128** 等、実装固定
export function restoreRandom(s: RandomState): Random;

export interface Clock { now(): number; }                        // ms。core内では tick数から導出
```

### GameState
```ts
export interface GameState {
  readonly tick: number;                // 1/60 秒単位の経過フレーム
  readonly rng: RandomState;
  readonly scene: SceneState;           // どのシーンにいるか（map / battle / menu / shop / title / gameover）
  readonly map: MapState;
  readonly party: PartyState;
  readonly actors: Record<ActorId, ActorState>;
  readonly switches: Record<SwitchId, boolean>;
  readonly variables: Record<VariableId, number>;
  readonly selfSwitches: Record<`${MapId}:${EventId}:${string}`, boolean>;
  readonly interpreters: InterpreterState[];   // 03 参照。並列イベント分含む
  readonly battle?: BattleState;                // 04 参照
  readonly message: MessageState;               // 表示中テキスト・選択肢・入力待ち
  readonly timers: TimerState;
  readonly playtimeTicks: number;
}

export interface MapState {
  readonly mapId: MapId;
  readonly player: Character;
  readonly events: Record<EventId, EventRuntime>;   // 位置・向き・現在ページ・移動ルート進行
  readonly followers: Character[];
  readonly camera: { x: number; y: number };
  readonly transfer?: { to: MapId; x: number; y: number; dir: Direction; fade: "black" | "white" | "none" };
  readonly encounterSteps: number;
}

export interface Character {
  readonly x: number; readonly y: number;      // タイル座標
  readonly realX: number; readonly realY: number; // 補間用（タイル単位の小数）
  readonly direction: Direction;
  readonly moving: boolean; readonly speed: 1|2|3|4|5|6;
  readonly graphic?: { asset: AssetId; index: number };
  readonly through: boolean;
}
```

### Action と遷移
```ts
export type Action =
  | { type: "input"; input: InputFrame }             // 1フレーム分の入力
  | { type: "tick" }                                 // 時間を1フレーム進める
  | { type: "startGame"; project: ProjectView }
  | { type: "loadSnapshot"; snapshot: SaveSnapshot }
  | { type: "askConfirm"; kind: "save" | "load"; slot: number }   // メニューのセーブ/ロード画面に確認ダイアログを出す（runtime が発行）
  | { type: "interpreter"; ...InterpreterAction }    // 03
  | { type: "battle"; ...BattleAction };             // 04

export interface InputFrame {
  readonly pressed: ReadonlySet<Button>;   // このフレームで押されている
  readonly triggered: ReadonlySet<Button>; // このフレームで押下開始
  readonly pointer?: { x: number; y: number; down: boolean };
}
export type Button = "up"|"down"|"left"|"right"|"ok"|"cancel"|"menu"|"shift"|"pageup"|"pagedown";

export interface Ctx {
  readonly project: ProjectView;           // Project + ロード済み MapData の読み取り専用ビュー
  readonly commands: CommandRegistry;       // 03
  readonly formulas: FormulaRegistry;       // 05
}

export interface StepResult { state: GameState; effects: Effect[] }

export function initialState(ctx: Ctx, seed: string): GameState;
export function step(state: GameState, input: InputFrame, ctx: Ctx): StepResult;  // = 1フレーム
export function dispatch(state: GameState, action: Action, ctx: Ctx): StepResult;
```
`step` は `dispatch(input)` → `dispatch(tick)` の合成で、`runtime` はこれだけを呼ぶ。

### Effect（core → 外界への要求）
```ts
export type Effect =
  | { kind: "playSe"; audio: AudioRef }
  | { kind: "playBgm"; audio: AudioRef; fadeMs?: number }
  | { kind: "stopBgm"; fadeMs?: number }
  | { kind: "screenShake"; power: number; durationTicks: number }
  | { kind: "screenFlash"; color: RGBA; durationTicks: number }
  | { kind: "screenTint"; color: RGBA; durationTicks: number }   // M6：色調（a = 0 で元に戻る）
  | { kind: "screenFade"; to: 0 | 1; durationTicks: number; color?: "black" | "white" } // M6：暗転（1）/ 明転（0）。暗転は明転を指示するまで続く。color は暗転の色（省略は黒。色の無い明転は今の色のまま戻る）
  | { kind: "requestSave"; slot?: number; confirmed?: boolean }   // confirmed = 確認ダイアログで「はい」の後
  | { kind: "requestLoad"; slot?: number; confirmed?: boolean }
  | { kind: "requestMapData"; mapId: MapId }   // 遅延ロード。runtime が Ctx に供給してから再開
  | { kind: "log"; level: "debug"|"info"|"warn"; message: string }
  | { kind: "plugin"; name: string; payload: unknown };
```
Effect は**発行した瞬間に状態から消える**（状態に副作用キューを持たない）。`runtime` は返された `effects` を同フレーム内で処理する。

### ProjectView（Ctx に渡す読み取りビュー）
```ts
export interface ProjectView {
  readonly project: Project;
  map(id: MapId): MapData | undefined;       // 未ロードなら undefined → core は requestMapData を発行
  actor(id: ActorId): Actor | undefined; skill(id: SkillId): Skill | undefined; /* 他エンティティも同様 */
}
```

### 移動・衝突
```ts
export function canPass(map: MapData, tileset: Tileset, events: Record<EventId, EventRuntime>,
                        ch: Character, dir: Direction): boolean;
export function moveCharacter(ch: Character, dir: Direction, ctx: PassabilityCtx): Character;
export function activePage(ev: MapEvent, state: GameState, mapId: MapId): EventPage | undefined;
export function eventsToTrigger(state: GameState, ctx: Ctx, kind: "action"|"touch"|"eventTouch"|"autorun"|"parallel"): EventId[];
```

### Snapshot
```ts
export const SNAPSHOT_VERSION = 1 as const;
export interface SaveSnapshot {
  version: number;
  projectId: string; projectHash: string;   // 互換判定用（11 参照）
  savedAt: string;                          // ISO。runtime が Clock から与える
  playtimeTicks: number;
  state: SerializedGameState;               // GameState から一時表示状態を除いたもの
  preview: { mapName: string; partyNames: string[]; level: number };
}
export function toSnapshot(s: GameState, meta: { projectId; projectHash; savedAt }): SaveSnapshot;
export function fromSnapshot(snap: SaveSnapshot, ctx: Ctx): Result<GameState, SnapshotError>;
export const snapshotMigrations: readonly { from: number; to: number; migrate(s: unknown): unknown }[];
```

## 不変条件
1. `step` は純粋：同じ `(state, input, ctx)` に対して同じ `StepResult` を返す。
2. `step` は `state` を変更しない（`Object.isFrozen` で検査可能）。
3. `state.tick` は `step` ごとにちょうど 1 増える。
4. `fromSnapshot(toSnapshot(s)).value` は `s` から一時状態を除いたものと deep-equal。
5. `moveCharacter` の結果は常に `canPass` が真のときのみ座標が変わる。
6. `Random` は `serialize → restore` で同じ列を生成する。

## テスト要件
- `Random`：既知シードに対する最初の10値の固定テスト、`fork` の独立性。
- `step` の純粋性・凍結をプロパティテストで検証（`test-utils/arbitraries/state.ts`）。
- 移動：通行フラグ×方向×イベント配置のテーブル駆動テスト。
- ページ条件：`activePage` の優先順位テスト（後ろのページが優先）。
- Snapshot ラウンドトリップのプロパティテスト。
- **リプレイテスト**：`fixtures/replays/*.json`（seed + InputFrame[] + 期待される最終状態ハッシュ）を全件実行。

## 完了条件
- `initialState` → 100 フレーム `step` してプレイヤーがマップ上を歩ける（`render-null` + `input-script` を使う統合テストで確認、06 と連携）。
- Snapshot ラウンドトリップが通る。
- リプレイフィクスチャ最低3本。

## 実装メモ（M1 で確定した点）
- **`step` の合成**：`dispatch(input)` → `dispatch(tick)` と同じ結果だが、`step` は同じ `InputFrame` を `CommandCtx.input` にも渡す（`dispatch(tick)` 単体では空入力）。M1 のコマンドは `input` を参照しないので結果は一致する（テストで検証）。
- **`GameState` への追加**：`nextInterpreterId`（インタプリタ id の連番）。`MapState.name`（セーブのプレビュー用）。`MapState.transfer.requested`（`requestMapData` を一度だけ発行するため）。`MessageState` は常に全フィールドを持つ（`owner` = 表示中のインタプリタ id、`face` / `choices` は `null`）。
- **`EventRuntime`** = `Character` + `id` / `pageIndex`（無効なら `null`）/ `trigger` / `priority`。有効ページの内容（`through`・`graphic`・`direction`）を毎フレーム写す。ページが無効なイベントは衝突も起動もしない。
- **場所移動**：`transfer` を予約し、次の `tick` で適用する。移動先が未ロードなら `requestMapData` を一度だけ発行して待つ。`initialState` も開始マップが未ロードなら開始位置への場所移動を予約する。
- **移動速度**：1 フレームに `2^speed / 256` タイル（speed 4 で 16 フレーム/タイル）。方向キーの同時押しは 下 > 左 > 右 > 上。
- **イベント起動**：決定ボタンは「足元の（`same` 以外の）アクションイベント」→「目の前の `same` のアクションイベント」の順。接触イベント（`touch` と `eventTouch`）は、`same` は突き当たったとき、それ以外は足元に到着したときに起動する。`eventTouch` の `same` のイベントは、移動ルートでプレイヤーのタイルへ進もうとしたときにも起動する（03 の `MoveStep`）。自動実行は通常のインタプリタが動いていないときに起動し、ページが有効な間は繰り返す。並列処理は有効ページごとに 1 つ起動し、ページが無効になると止まる。
- **`Snapshot`**：「一時状態」= 移動の補間中の位置（`realX/realY/moving`）。`toSnapshot` は目的のタイルに確定させて保存する（`stripTransient`）。`fromSnapshot` は zod で構造を検証し、壊れていれば `Err`。マイグレーションは `migrateSnapshot(snap, version, target?, registry?)`。
- **`Random`**：xoshiro128**（参照実装の既知ベクトルで検証）。`fork(label)` は元のシードとラベルだけで決まる。
- `ProjectView` は `createProjectView(project, maps)` で作れる。`maps` は参照で保持され、後から追加すれば遅延ロードの完了として反映される。`createCtx(view)` は組み込みコマンドと式関数を登録済みの `Ctx` を返す。
- 戦闘（`battle` の Action / `BattleState`）は M4。`BattleState` は型だけのプレースホルダ。

## 実装メモ（M2 で確定した点）
- **イベントページの更新は 1 フレームに 2 回**：フレームの頭と、インタプリタ実行の直後（イベントが変えたスイッチ・変数・セルフスイッチを同じフレームのうちにページへ反映する。次のフレームの入力フェーズで古いページが起動しないように）。

## 実装メモ（M3 で確定した点）
- **`SceneState` は判別共用体**：`{ kind: "map" }` / `{ kind: "title"; screen: "main" | "continue"; cursor }` / `{ kind: "menu"; screen: "main" | "item" | "status" | "save" | "load"; cursor }` / `{ kind: "battle" | "gameover" }`（後者は M4 まで placeholder）。タイトル・メニューの UI 状態（画面・カーソル）は `GameState` の一部なので、UI 操作も入力列から再現でき、リプレイできる（`fixtures/replays/menu-save.json`）。実装は `game/uiPhase.ts`（入力）と `game/scenes.ts`（定数：`TITLE_ITEMS` / `MENU_ITEMS` / `SAVE_SLOT_FIRST = 1` / `SAVE_SLOT_COUNT = 10` / `menuItemIds`）。表示文言は core に持たず、`system.terms[key]` を runtime が引く（`key` = `TITLE_ITEMS` / `MENU_ITEMS` の要素）。
- **タイトル**：`titleState(ctx, seed)` は `initialState` をタイトルシーンにしたもの。`initialState` 自体は従来どおりマップシーンから始まる（リプレイのハッシュを変えないため）。`main`：上下でカーソル（循環）、決定で「ニューゲーム」＝ `initialState(ctx, state.rng.seed)` から作り直す（`tick` は数え続け、`playtimeTicks` は 0 から。`stopBgm` を発行）／「コンティニュー」＝ `continue` 画面へ。`continue`：スロット 1〜10 のカーソル、決定で `requestLoad { slot }`、キャンセルで `main`。**core はスロットが空かどうかを知らない**（読み込めるかは runtime が決める）。
- **メニュー**：マップ上で「プレイヤーが止まっていて、メッセージ・通常インタプリタ・場所移動が無い」ときに `menu` または `cancel` で開く。`main` の 4 コマンドから、`item`（所持数 1 以上を ID 順。M3 では使えない）／`status`（上下または pageup/pagedown でメンバー切り替え）／`save`・`load`（決定で `requestSave` / `requestLoad { slot: 1 + cursor }`。画面は開いたまま）。キャンセルは一つ前の画面（`main` ならマップ）へ、`menu` ボタンは一度に閉じる。カーソルは押下開始（`triggered`）だけで動く（押しっぱなしのリピートは無い）。
- **確認ダイアログ**（セーブ/ロード画面）：`menu` シーンの `confirm?: { kind: "save" | "load"; slot; cursor: 0 | 1 }`（0 = はい / 1 = いいえ。誤操作しにくいよう **「いいえ」から始まる**）。出すかどうかは **runtime が判断**し（06 参照）、`askConfirm` Action で開く（メニュー以外では何もしない）。開いている間は一覧のカーソルは動かず、上下左右で はい/いいえ を切り替え、決定で確定（はい = `requestSave` / `requestLoad { slot, confirmed: true }`。いいえ = 何も要求せず閉じる）、キャンセルで閉じる、`menu` ボタンでメニューごと閉じる。ダイアログの開閉も `GameState` の一部なので入力列から再現できる。`progressFingerprint(state)` は「セーブに値する進行」の指紋（`stripTransient` から `tick` / `playtimeTicks` を除いたキー順序に依らない文字列）で、保存直後と一致し、歩く・拾う・スイッチが変わるなどで変わる（メニューの開閉・時間だけの経過では変わらない）。
- **世界は止まる**：タイトル・メニューの間は `handleTick` が `tick`（メニューでは `playtimeTicks` も）だけ進め、移動・イベント・並列処理は動かない（不変条件 3 は保たれる）。
- **Snapshot**：セーブされるのはマップシーンだけ。`stripTransient` は `title` / `menu` のシーンを `{ kind: "map" }` に戻す（メニューからセーブしても、ロードするとマップから再開する）。`fromSnapshot` の検証スキーマも `scene` は `map` のみ（`battle` は M4 で追加）。`dispatch({ type: "loadSnapshot" })` は成功すると状態を丸ごと置き換え、場所移動の予約が残っていれば `requested` を `false` に戻す（マップが未ロードでも `requestMapData` を出し直せるように）。失敗（`Err`）は状態を変えず `log` の warn だけを返す。

## 実装メモ（M4 で確定した点）
- **`BattleState`** は `battle/state.ts` で定義し（04）、`GameState.battle` は戦闘中（`scene.kind === "battle"`）だけ存在する。`SceneState` の `battle` / `gameover` に中身はない。
- **`Ctx`** の型は `ctx-types.ts` に分けた（`ctx.ts` は `createCtx` と再エクスポート）。`createCtx` が組み込みコマンドを import し、そのコマンド（`BattleProcessing`）が戦闘を import するので、戦闘が `ctx.ts` から型を import すると循環になるため。`Ctx` に任意の `battleRules?` を追加。`paramAt` は `params.ts` に移した（公開は従来どおり）。`ProjectView` に `state(id)` を追加。
- **入力・時間経過**：`handleInput` はシーンが `battle` なら `battleInput`、`gameover` なら決定/キャンセルでタイトルへ（`tick` は数え続ける）。`handleTick` は `gameover` では `tick` だけ、`battle` では `tick` と `playtimeTicks` を進めて `battleTick`（マップの世界は動かない）。
- **`stripTransient`** はタイトル・メニュー・戦闘・ゲームオーバーの状態をマップに戻し、`battle` を落とす（`SerializedGameState` は `battle` を除いたもの）。

## 実装メモ（M6 で確定した点）
- **`MessageState` の追加**：`cursor?: number`（選択肢のカーソル、または数値入力で編集中の桁）と `numberInput?: { digits, value }`（数値入力）。どちらも選択肢・数値入力のときだけ存在する省略可能なフィールドにした（普通の文章のときは付かないので、既存のリプレイのハッシュも変わらない）。`choices` が非 null のときは `text` が見出しになる。セーブのスキーマ（`snapshot.ts`）も省略可能で、古いセーブがそのまま読める。
- **メッセージ表示中の入力**（`game/messageInput.ts`）：選択肢は上下でカーソル（循環）・決定で選ぶ・キャンセルは持ち主のインタプリタの `locals.choiceCancel`（整数）があればその番号を選ぶ。数値入力は左右で桁、上下で数字（0〜9 を循環）、決定で確定。文章は決定/キャンセルで閉じる。答えは持ち主の `locals.answer` に書いてメッセージを閉じ、コマンドの `resume` がそれを読んで続きへ進む（`CommandResult.setLocals` で消す）。
- **タイマー**：`timers = { active, ticks }` の `ticks` は残りフレーム。マップシーンの `tick` ごとに 1 減り、0 になったら `active` が偽になる（メニューや戦闘の間は止まる）。
- **`initialState` / `titleState` / `gainExp`** は `Ctx` 全体ではなく `Pick<Ctx, "project">` を受け取る（`ReturnToTitle` など、コマンドから呼ぶため）。
- **`SceneState` に `shop`**：`{ kind: "shop"; goods; canSell; owner; screen: "command" | "buy" | "sell"; cursor; quantity? }`（`ShopScene`）。`ShopProcessing`（03）が開き、閉じるとマップに戻る。入力は `game/shop.ts`、`handleTick` はメニューと同じく `tick` とプレイ時間だけを進める。`stripTransient` はマップに戻す。`WaitState` に `{ kind: "shop" }` を追加した。
