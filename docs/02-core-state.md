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
  readonly scene: SceneState;           // どのシーンにいるか（map / battle / menu / title / gameover）
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
  | { kind: "requestSave"; slot?: number }
  | { kind: "requestLoad"; slot?: number }
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
export function eventsToTrigger(state: GameState, ctx: Ctx, kind: "action"|"touch"|"autorun"|"parallel"): EventId[];
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
