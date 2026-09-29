# 04. `@rpg/core` — 戦闘システム

## 責務
- ターン制戦闘（初期実装は「全員コマンド入力 → 敏捷順に解決」の RPGツクール2000/MV 型）。
- 行動の解決（ダメージ、回復、状態異常、バフ）。
- 勝利/敗北/逃走の判定と報酬計算。
- 敵AIの行動選択。

## 非責務
- 戦闘画面のレイアウト。→ `runtime` の FrameSpec 投影。
- 数式の解析。→ 05（本パッケージは評価器を呼ぶだけ）。

## 依存が許されるパッケージ
`@rpg/schema`、同パッケージ内の 02/03/05。

## 公開インターフェース

### BattleState
```ts
export interface BattleState {
  readonly troopId: TroopId;
  readonly phase: "start" | "input" | "resolve" | "victory" | "defeat" | "escape" | "aborted";
  readonly turn: number;
  readonly enemies: Record<BattlerId, EnemyBattler>;
  readonly party: BattlerId[];                 // ActorId をそのまま BattlerId として使う
  readonly inputCursor: { actorIndex: number; menu: "command" | "skill" | "item" | "target" };
  readonly actions: BattleAction[];            // 入力済み。resolve で消化
  readonly queue: BattleAction[];              // 敏捷順にソート済み
  readonly log: BattleLogEntry[];              // 表示用。runtime が消費
  readonly canEscape: boolean; readonly canLose: boolean;
  readonly rng: RandomState;                   // 戦闘専用ストリーム（fork）
}

export interface Battler {
  readonly id: BattlerId; readonly name: string;
  readonly hp: number; readonly mp: number;
  readonly params: Record<Param, number>;      // 装備・バフ適用後
  readonly states: { id: StateId; turns: number }[];
  readonly buffs: Partial<Record<Param, number>>;   // -2..+2
}
export interface EnemyBattler extends Battler { enemyId: EnemyId; x: number; y: number; hidden: boolean }

export interface BattleAction {
  subject: BattlerId;
  kind: "attack" | "skill" | "item" | "guard" | "escape";
  skillId?: SkillId; itemId?: ItemId;
  targets: BattlerId[];
}
```

### 遷移
```ts
export function startBattle(state: GameState, troop: TroopId, opts: { canEscape; canLose }, ctx: Ctx): GameState;
export function battleStep(state: GameState, input: InputFrame, ctx: Ctx): StepResult;   // 1フレーム
export function resolveAction(state: GameState, action: BattleAction, ctx: Ctx): { state: GameState; log: BattleLogEntry[] };
export function chooseEnemyAction(enemy: EnemyBattler, state: GameState, ctx: Ctx, rng: Random): BattleAction;
export function calcDamage(skill: Skill | Item, a: Battler, b: Battler, ctx: Ctx, rng: Random): Result<DamageResult, EvalError>;
export function battleOutcome(b: BattleState): "ongoing" | "victory" | "defeat";
export function applyRewards(state: GameState, troop: Troop, ctx: Ctx): { state: GameState; exp: number; gold: number; drops: ItemId[] };
```

### 拡張ポイント（FormulaRegistry は 05）
- ダメージ式は `Skill.formula` を 05 の評価器でスコープ `{ a, b, v(id), s(id) }` を与えて評価する。
- 状態異常の効果、命中/回避/会心の計算は `BattleRules` オブジェクトとして注入可能にする（プラグインで差し替え）。
```ts
export interface BattleRules {
  hitRate(a: Battler, b: Battler, skill: Skill): number;
  critRate(a: Battler, b: Battler, skill: Skill): number;
  sortQueue(actions: BattleAction[], battlers: Record<BattlerId, Battler>, rng: Random): BattleAction[];
  escapeRate(party: Battler[], enemies: Battler[]): number;
}
export const defaultBattleRules: BattleRules;
```

## 不変条件
1. `hp` は常に `0 <= hp <= mhp`。`mp` も同様。
2. `resolveAction` は `subject` が戦闘不能なら no-op（log に "cannot act" を残す）。
3. `phase === "resolve"` で `queue` が空になったら必ず `input` か終了フェーズへ進む（詰まらない）。
4. 戦闘の RNG はマップの RNG と独立（`fork("battle")`）：戦闘の結果がフィールドの乱数列に影響しない。
5. `battleOutcome` は敵全滅で `victory`、味方全滅で `defeat`。両方同時は `defeat`。

## テスト要件
- `calcDamage`：式・パラメータ・乱数のテーブル駆動テスト（乱数は固定シード）。
- `resolveAction`：単体/全体/自分/味方スコープの対象解決。
- 状態異常：付与→ターン経過→解除。
- 敵AI：`rating` と `condition` に基づく選択分布を統計的に検証（1000回試行で許容誤差内）。
- 戦闘全体：`fixtures/replays/battle-*.json` のリプレイ。
- プロパティ：任意の合法な行動列で `hp` 範囲不変条件が保たれる。

## 完了条件
- タイトル → マップ → `BattleProcessing` → 勝利 → マップ復帰 のリプレイフィクスチャが通る。
- 敗北時 `canLose=false` で `gameover` シーンへ遷移する。
