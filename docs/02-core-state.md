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
  readonly mapTiles?: Record<MapId, Record<string, number>>; // ChangeMapTile で書き換えたマス（マップごと。書き換えるまで無い）
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
  readonly encounterSteps: number;   // 戦闘から（逃走も含む）あるいた歩数。ランダムエンカウントの判定に使う
  readonly turns?: number;           // このマップに入ってからの、プレイヤーの手数（歩く・岩を押す・足踏み）。`pace: "playerStep"` のルートが見る。数え始めるまで無い（0 と同じ）
  readonly turnWait?: number;        // 振り向き（system.turnInPlace）のあと、押しっぱなしでも歩き出さずに待つ残りのフレーム数。無ければ待たない
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
export function eventsToTrigger(state: GameState, ctx: Ctx, kind: "action"|"touch"|"eventTouch"|"eventSight"|"autorun"|"parallel"): EventId[];
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
- **イベント起動**：決定ボタンは「足元の（`same` 以外の）アクションイベント」→「目の前の `same` のアクションイベント」の順。接触イベント（`touch` と `eventTouch`・`eventSight`）は、`same` は突き当たったとき、それ以外は足元に到着したときに起動する。`eventTouch`・`eventSight` の `same` のイベントは、移動ルートでプレイヤーのタイルへ進もうとしたときにも起動する（03 の `MoveStep`）。`eventSight` は、さらに視界にプレイヤーが入ったときにも起動する（毎フレームの「移動の補間」のあと。03）。自動実行は通常のインタプリタが動いていないときに起動し、ページが有効な間は繰り返す。並列処理は有効ページごとに 1 つ起動し、ページが無効になると止まる。
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
- **セーブの 3 種類**：①メニューから（従来。`save` 画面の決定が `requestSave { slot }`。`system.menuSave: false` でメインメニューから「セーブ」を外せる）、②イベントから（`SaveGame`＝セーブポータル。同じセーブ画面を直接開く。03）、③オートセーブ（`system.autosave.onTransfer`）。どれも `requestSave` Effect で、書き込みは runtime（06）。
- **オートセーブ**：`handleTick` の場所移動（`applyTransfer`）が移動先に着いたとき、`autosaveOnTransfer(project)` なら `{ kind: "requestSave", slot: AUTOSAVE_SLOT }`（`AUTOSAVE_SLOT = 0`、`confirmed` なし）を 1 つ出す。保存されるのは移動が済んだ状態で、移動を待っていたインタプリタは次の `tick` で続きから動く（ロードしても同じ）。
- **メニューのコマンドの並び**（`game/scenes.ts`）：`menuItems(project)`。`MENU_ITEMS`（`item` / `skill` / `status` / `save` / `load`）から、`system.menuSave === false` のとき `save` を、`system.menuSkill` が `true` でないとき `skill` を除いたもの。メインメニューのカーソル・行数・サブ画面から戻るときのカーソル位置はこの並びに従う。`MenuScene.portal`（イベントが開いたセーブ/ロード画面）はキャンセルで直接マップに戻る。`handleMenuInput` の「キャンセルは一つ前の画面へ」の例外。
- **スロット一覧の対応**（`game/scenes.ts`）：カーソル位置 → スロット番号は `saveSlotNumbers()`（セーブ画面。1〜`SAVE_SLOT_COUNT`）と `loadSlotNumbers(project)`（ロード画面とタイトルのコンティニュー。オートセーブが有効なら先頭にスロット 0 が付き、11 行になる。無効なら従来どおり 10 行）。セーブ画面にスロット 0 は並ばず、手動では書けない。`handleMenuInput` は `ctx` を取る（ロード画面の行数がプロジェクトの設定に依るため）。

## 実装メモ（ランダムエンカウント・メニューでの使用）
- **ランダムエンカウント**（`map/encounter.ts`・`game/tickPhase.ts`）：プレイヤーが 1 歩を歩き終えたとき（移動の補間が終わった `advanceMovement`）、足元に「接触」のイベントが無く、通常のインタプリタも場所移動の予約も無ければ、`MapData.encounters` のあるマップで判定する（`startEncounter`）。`encounterSteps` を 1 足して `rollEncounter(map, steps, seed, tick)`：戦闘（逃走も含む）から `floor(encounterStep / 2)` 歩までは遭遇せず、それ以降は 1 歩ごとに `1 / (encounterStep - 安全歩数)` の確率で遭遇する（平均がほぼ `encounterStep` 歩になる）。遭遇したらトループを `weight` の比で選び、`startBattle`（逃走可・敗北でゲームオーバー）で戦闘シーンに入る。戦闘 BGM（`system.bgm.battle`）は `BattleProcessing` と同じに `playBgm` で鳴らす。
- **乱数は独立の列**：判定は `createRandom(seed).fork("encounter:" + tick)` から引くので、マップの乱数（`rng`）を進めない（`battle:<tick>` の戦闘の列とも別）。エンカウントがあるかどうかでイベントの乱数列は変わらず、同じシード・同じ歩き方なら、リプレイでも同じ歩数・同じ敵で遭遇する。
- **歩数のリセット**：`startBattle` が `map.encounterSteps` を 0 に戻す（`BattleProcessing` で始めた戦闘も、勝っても逃げても）。戦闘が終わったら、最初の `floor(encounterStep / 2)` 歩は安全。場所移動（`enterMap`）でも 0 から数え直す。戦闘の結果は、インタプリタが待っていなければ（ランダムエンカウント）`leaveBattle` がそのままマップに戻す（`BattleProcessing` の分岐は無い）。全滅（`canLose: false`）は `gameover`。
- **メニューでのアイテム・スキルの使用**（`game/fieldUse.ts`・`game/uiPhase.ts`）：`MenuScreen` に `skill` を足した。`item` 画面の決定で、使えるアイテム（効果のある消耗品。`fieldItemUsable`）なら対象の味方の選択（`MenuScene.pick`、`MenuPick`：`{ kind: "item", id, cursor }` / `{ kind: "skill", id, user, cursor }`。`cursor` は `party.members` の位置）に進み、上下で選んで決定で使う。キャンセルで選択をやめる。`skill` 画面は、使う人を選び（`cursor`）、決定でその人（`MenuScene.actor`）のスキル一覧に進み、キャンセルで使う人の選択に戻る。スキルは味方に向けたもの（`self` / `one-ally` / `all-allies` / `one-dead-ally`。`fieldSkillUsable`）だけ使え、`self`・全体のスキルは決定でそのまま使う（対象を選ばない）。
- **効果は戦闘と同じ解決**：`useOnField(state, ctx, use, target?)` は、パーティだけの戦闘状態（敵なし）を作って `resolveAction` を呼ぶので、式（ダメージ式のばらつきも）・HP/MP の回復・蘇生・MP の消費・アイテムの消費は戦闘と同じ。何も回復しなかった（満タン・MP 不足・対象が合わない・アイテムが無い）ときは `undefined`（アイテム・MP は減らさず、画面は対象の選択を終えるだけ）。状態異常・強化は戦闘の外には持ち越されないので、HP/MP の回復だけが残る。乱数は `field:<tick>` の独立の列で、マップの乱数には触れない。

## 実装メモ（滑る床・押せる岩）
- **氷の床の滑り**（`map/slide.ts`・`game/tickPhase.ts`）：プレイヤーが 1 歩を歩き終えたとき（`advanceMovement`）、足元に接触イベントが無く、通常のインタプリタも場所移動の予約も無ければ、そのタイルが氷（`isIce`。`Tileset.ice` のタイルがどれかのレイヤにある）なら、同じ向きにもう 1 歩を始める（`slide`。通れなければ止まる）。移動は途切れずに `moving` のままなので、滑っている間はプレイヤーは操作できない。止まるのは、壁・通れないイベント（岩など）に突き当たる、氷でないタイルに着く、足元に接触イベント（階段など）がある、イベントが始まる、のどれか。歩数（`encounterSteps`）は滑りきって止まった所で 1 歩として数え、ランダムエンカウントもそこで判定する（滑っている途中では起きない）。状態に足したものは無く、既存のリプレイのハッシュは変わらない。
- **押せる岩**（`map/slide.ts` の `pushableAt`・`game/inputPhase.ts`）：方向キーで進めなかったとき、目の前が「有効なページが `pushable` で、通常プライオリティ・`through` でない」イベントで、その先へ通れる（`canPass`）なら、岩を 1 タイル押して、プレイヤーも同じ向きに 1 タイル進む。岩の向きは変えず、引くことはできない。岩は滑らない（押した所で止まる）が、滑るプレイヤーの止まる目印になる（滑りは岩の手前で止まる）。**触れる・話しかけると何かが起こるイベント**（有効なページのトリガが `action` / `touch` / `eventTouch` / `eventSight`）のあるタイルへは押せない（階段・台座・扉の上に岩を載せて、通れなくしてしまわないため。感圧板のような `parallel` のイベントは、押された岩が上に載る）。押したときは、岩に `touch` のページがあっても突き当たりの接触は起きない。
- **イベントの位置を読む**：式の関数 `evx(id)` / `evy(id)`（05）。押した岩が板の上にあるかを、並列イベントが毎フレーム調べられる。
- **`SetEventLocation`**（03）：イベントを瞬間移動する（岩をもとの位置へ戻す仕掛けなど）。マップに入り直すと、イベントはマップの定義の位置に戻る（`enterMap`）。
- **マップのタイルの書き換え**（`map/tiles.ts`・`ChangeMapTile`。03）：`GameState.mapTiles[mapId]` に、書き換えたマスだけを `"<レイヤ>:<x>,<y>"`（`tileKey`）→ タイル番号（0 = 空）で持つ。`MapData`（`ProjectView.map`）は不変のまま、通行判定・氷・移動ルート・描画は、書き換えを重ねたマップ（`currentMap(project, state, mapId?)`。同じ `MapData` と同じ書き換えには同じ結果を返すようキャッシュする）を見る。書き換えはマップを出入りしても残り、セーブにも含まれる（`snapshot` の検証スキーマに `mapTiles` を追加。無いセーブもそのまま読める）。書き換えるまで `mapTiles` は無いので、既存のリプレイのハッシュは変わらない。範囲外のレイヤ・座標の書き換えは無視する。デモ「水門の遺跡」（`fixtures/projects/v1/water`）で使っている。

## 実装メモ（ターン制の移動ルート）
- **`MapState.turns?: number`**（`state.ts`）：このマップに入ってからの、プレイヤーの手数。`enterMap` が新しい `MapState` を作るので、マップに入り直すたびに 0 から数え直す（場所移動・同じマップへの場所移動でも）。セーブ（`snapshot`）の検証スキーマに省略可の項目として足した（`SNAPSHOT_VERSION` は上げない。数え始めるまで無いので、ターン制を使わないゲームの状態・ハッシュは変わらない）。
- **振り向き**（`system.turnInPlace: true`。`game/inputPhase.ts`）：いまの向きと違う方向キーを**押した瞬間**（`input.triggered`）は、移動せずに `player.direction` だけ変える。手数にも数えず、`turns` も足さない（ターン制のイベントは動かない）。キーボードの押し方は数フレーム押されたままになるので、向きを変えたあと `MapState.turnWait`（残りのフレーム数。`TURN_IN_PLACE_FRAMES` = 10 から数える）が 0 になるまでは、押しっぱなしでも歩き出さない（軽く押して離せば向きだけ変わる）。待ち時間のうちに向いた方向をもう一度押せば（`triggered`）、待たずにすぐ歩く。向いている方向への入力は従来どおり歩く。`turnWait` は歩き出す・方向キーを離すと消える（セーブの検証スキーマに省略可の項目として足した）。目の前の `action` イベントに向きを合わせてから決定ボタンを押す、といった操作ができる。
- **数えるもの**（`game/inputPhase.ts`・`map/paced.ts` の `withTurn`）：方向キーで**歩き出した**（通れずに向きだけ変わったときは数えない）、岩を押した、決定ボタンで**足踏みした**（目の前・足元の `action` イベントが無く、有効なページが `moveRoute.pace: "playerStep"` のイベント、または `SetMoveRoute` のターン制のルートで動かされているイベントがマップに居るときだけ。居なければ何も起こらず、数えない。歩いたときも岩を押したときも同じで、居なければ状態に `turns` を足さない）。氷の上で滑っている間は数えない（滑りは歩きの続き）。数えるのは歩き出した入力フェーズなので、同じフレームの `handleTick` で、ターン制のイベントがもう動き出す。
- **ターン制のイベントが歩いている間は、プレイヤーは次の手を打てない**（`pacedEventsMoving`。入力フェーズは何もしない）。プレイヤーとイベントの速さが同じなら、みんなが同じフレームに着く。ターン制のイベントは、速さを変えないこと（遅いと、その分プレイヤーも待つ）。
- **使い道**：デモ「時の番人の回廊」（`fixtures/projects/v1/clock`）。倉庫番風の謎解き、忍び込みの見張り、チェスのようなパズルにも使える。

## 実装メモ（プラグインの保存領域 `pluginState`）
- **`GameState.pluginState?: Readonly<Record<string, JsonValue>>`**（`state.ts`）：プラグインが自分の状態を置く領域。キーはプラグインの名前、値は JSON にできる値（`JsonValue`。`undefined` は含めない）。書き込むまで無いので、プラグインを使わないゲームの状態・リプレイのハッシュは変わらない。読み書きは `pluginStateOf(state, name)` / `withPluginState(state, name, value)`（どちらも `@rpg/plugin-api` から再エクスポート。後者は自分以外のプラグインのキーに触れない）。`null` を書けば「持っていない」ことを表せる（キーは残る）。
- **セーブ**：`snapshot` の検証スキーマに `pluginState`（キーごとに JSON の値）を足した。JSON でない値（関数・`undefined` など）の入ったセーブは弾く。`pluginState` の無いセーブはそのまま読める。**`SNAPSHOT_VERSION` は上げていない**：足したのは省略できる項目だけで、これまでのセーブは変換なしで読めるから（バージョンを上げると、`pluginState` を使わないゲームのセーブまで古いビルドで読めなくなる）。古いビルドが `pluginState` の入ったセーブを読むと、検証で「不正」として弾かれる。
- **使い道**：デモ「風鳴りの洞窟」（`@rpg/plugin-dungeon`。18）が、何階か・敵の位置と HP・落ちている物・歩いた場所・満腹度・ログを持つ。デモ「港町の釣り大会」（`@rpg/plugin-fishing`。19）は、図鑑（魚ごとの数と最大の大きさ）・大会の点数・釣りの 1 回分（待つ・あたり・巻き上げ）・図鑑や結果発表の画面を持つ。ほかに、クエストの記録・クラフトなど、数値の変数に収まらない状態をプラグインが持てる。

