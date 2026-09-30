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

## 実装メモ（M4 で確定した点）
- **実装範囲**：`BattleState`・行動の解決・敵AI・報酬・`BattleRules`・コマンド入力・状態異常/強化・逃走・ゲームオーバー。ソースは `packages/core/src/battle/`（`state` `battlers` `rules` `damage` `resolve` `ai` `rewards` `flow` `helpers`）。**未実装**：トループのイベントページ（`Troop.pages`）、ランダムエンカウント（`MapData.encounters`）、隠れた敵（`hidden` は型だけ）、戦闘中のコモンイベント効果（警告して無視）、アニメーション、味方の並び替え、後衛、戦闘中の装備変更。
- **公開インターフェースとの差**：
  - `Battler.params` は**装備適用後・強化/状態適用前の基本値**。実効値は `effectiveParam(ctx, b, param)` / `effective(ctx, b)`（式やルールには実効値のコピーを渡す）。`Battler.level` を追加。
  - `BattleState` に `enemyOrder`（敵の並び順）、`allies`（戦闘者としての味方。HP/MP は戦闘の終わりに `GameState.actors` へ書き戻す）、`guarding`、`popups`（ダメージ数字の一時表示）、`wait`（次の処理までの待ちフレーム）、`result` を追加。`inputCursor` は `{ actorIndex, menu, index, pick }`（対象選択の途中経過は `pick`）。`BattlerId` は味方 = `ActorId`、敵 = `e:<番号>`（ID に `:` は使えないので衝突しない）。敵の名前は同じ種類が複数いれば A, B… が付く。
  - `startBattle(state, troop, opts, ctx)` の `ctx` は `Pick<Ctx, "project">` で足りる（コマンドの `CommandCtx` をそのまま渡せる）。BGM は呼ばない（`BattleProcessing` が鳴らす）。
  - `battleStep` は入力と時間経過をまとめた単体テスト用。実際の `core.step` は入力フェーズで `battleInput`、時間経過で `battleTick` を呼ぶ。`resolveAction` は `{ state, log, warnings }` を返し、ログの追記とポップアップは呼び出し側（`commitLog`）が行う。`Ctx.battleRules?` で `BattleRules` を差し替える（省略時は `defaultBattleRules`）。`applyRewards` は `levelUps` も返す。
- **1 ターンの流れ**：`start`（遭遇ログ）→ `input`（味方が 1 人ずつコマンドを選ぶ。行動できない味方は飛ばす）→ 入力が済むと敵の行動を選び（`chooseEnemyAction`）、`rules.sortQueue` で並べて `resolve`（10 フレーム後に始まり、行動ごとに 30 フレーム置く。決定ボタンで待ちを飛ばせる。倒れた戦闘者の行動は黙って飛ばす）→ キューが空ならターン終了処理（状態による HP 増減 → 状態の残りターンを減らして解除 → 防御を解く）→ 次のターンの `input`。全員が行動できないターンは入力を待たずに解決へ進む（眠りを撒き続ける敵のようなデータでは、終わらない自動ターンになりうる）。勝敗は行動ごとに判定（`battleOutcome`）。
- **コマンド**：`attack / skill / item / guard / escape`（`escape` は `canEscape` のときだけ）。攻撃は組み込みの `ATTACK_SKILL`（式 `a.atk * 4 - b.def * 2`、範囲 `one-enemy`）。スキルは習得済み（クラスの `skills` でレベルが足りるもの）で MP が足りるものだけ選べる。アイテムは所持数 1 以上の消耗品で、範囲は「味方 1 人」固定（`Item` に scope が無いため）。範囲が一人を選ぶもの（`one-enemy` / `one-ally` / `one-dead-ally`）は対象選択（左右/上下で循環）へ、全体・自分・なしはそのまま確定。キャンセルは一つ前のメニュー（コマンドでは前の味方の選び直し）へ。
- **ダメージ**（`calcDamage`）：敵に向けた効果（`one-enemy` / `all-enemies`）は「命中判定 → 式 → ばらつき（±10%）→ 会心（倍率 2）」の順に乱数を引き（外れたら命中の 1 回だけ）、0 未満にならない。味方に向けた効果は命中・会心なしで、式が負なら回復。式は `a` / `b`（実効パラメータ）と `v(id)` / `s(id)`（`game` を渡したとき）が使え、空の式は 0。式が評価できないときは `Err`（`resolveAction` が警告にして 0 として扱う）。防御中の被ダメージは半分（最低 1）。
- **効果**（`SkillEffect`）：`recoverHp` / `recoverMp`（固定値。`one-dead-ally` なら蘇生）、`addState`（`chance` < 1 のときだけ乱数を引く。付与済みなら残りターンを延ばすだけでログは出さない）、`removeState`、`buff`（段階は -2〜+2 に収まり、1 段階 = ±25%）、`commonEvent`（戦闘中は未対応）。倒れた戦闘者は状態と強化を失う。状態は `Database.states`（01）で、`restriction: "cannotAct"` の間は行動できない（解決時に `cannotAct` を記録）。
- **乱数**：戦闘専用（`fork("battle:<tick>")`。戦闘ごとに別の列で、マップの `state.rng` には触れない）。ドロップの判定も `battle.rng` から。
- **敵AI**：条件（式。`a` = 行動する敵、`turn` = ターン。評価できない・真偽値でないときは偽）と MP を満たす行動のうち、最大 `rating` から 3 以内のものを `rating - (最大 - 3)` の重みで選ぶ。無ければ通常攻撃。対象は範囲に応じて生きている相手から無作為（全体・自分・なしは解決時に範囲から決まる）。
- **報酬**：勝利時に、経験値は生きている味方全員に同じ量、ゴールドは共有、ドロップは確率で所持品へ。累計経験値 `expToReach(L) = 20(L-1)² + 10(L-1)`（レベル上限 99）。レベルが上がると最大 HP/MP の増えた分だけ現在値も増える。戦闘の終わりに戦闘不能の味方は HP 1 で復帰する（メニューに回復手段が無い間の措置）。
- **終了**：結果表示（最低 30 フレーム）の後に決定/キャンセルで抜ける。勝利・逃走・`canLose` の敗北はマップに戻り、結果（`victory` / `escape` / `defeat` / `aborted`）を待っているインタプリタの `locals.battleResult` に渡す。`canLose` でない敗北は `gameover` シーン（決定でタイトルに戻る）。戦闘中はマップの世界（イベント・移動・並列処理）が止まり、メニューも開かない。
- **セーブ**：`battle` は保存しない。`stripTransient` は `title` / `menu` / `battle` / `gameover` のシーンをマップに戻して `battle` を落とす。戦闘の途中で復元されたインタプリタ（`BattleProcessing` の待機中）は結果が無いので逃走の分岐に進む。
- **テスト**：`damage` `resolve` `ai`（1000 回の分布）`rewards` `rules` `input`（メニュー操作）`flow`（勝利・敗北・逃走・報酬・独立した乱数）`battleProcessing`（コマンド経由の全経路）と、`battle.property.test.ts`（任意の入力列で HP/MP が範囲内・状態を変更しない・毎フレーム進む・同じ入力で同じ結果）。`fixtures/replays/battle-win.json` / `battle-escape.json`（タイトル → ニューゲーム → 歩く → 話しかけて戦闘 → 勝利/逃走 → マップ復帰。`title: true` で開始）。戦闘のテストデータは `test-utils` の `battleProject()` / `battleKit()`。
