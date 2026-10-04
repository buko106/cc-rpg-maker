import type { BuffParam, EnemyId, ItemId, Param, SkillId, StateId, TroopId } from "@rpg/schema";
import type { RandomState } from "../random.js";

/** 戦闘者の ID。味方は `ActorId` をそのまま使い、敵は `e:<番号>`（ID に `:` は使えないので衝突しない）。 */
export type BattlerId = string;

export type BattlePhase = "start" | "input" | "resolve" | "victory" | "defeat" | "escape" | "aborted";

/** 戦闘の終わり方。BattleProcessing の分岐（勝利 = 0、逃走 = 1、敗北 = 2）に対応する。 */
export type BattleOutcome = "victory" | "escape" | "defeat" | "aborted";

export interface BattlerStateEntry {
  readonly id: StateId;
  /** 残りターン数。0 は戦闘が終わるまで続く。 */
  readonly turns: number;
}

export interface Battler {
  readonly id: BattlerId;
  readonly name: string;
  readonly level: number;
  readonly hp: number;
  readonly mp: number;
  /** 装備を含み、強化/弱体・状態の補正は含まない基本値。実効値は `effectiveParam`。 */
  readonly params: Readonly<Record<Param, number>>;
  readonly states: readonly BattlerStateEntry[];
  /** 強化/弱体の段階（-2〜+2）。 */
  readonly buffs: Readonly<Partial<Record<BuffParam, number>>>;
}

export interface EnemyBattler extends Battler {
  readonly enemyId: EnemyId;
  readonly x: number;
  readonly y: number;
  readonly hidden: boolean;
}

export type BattleActionKind = "attack" | "skill" | "item" | "guard" | "escape";

export interface BattleAction {
  readonly subject: BattlerId;
  readonly kind: BattleActionKind;
  readonly skillId?: SkillId;
  readonly itemId?: ItemId;
  readonly targets: readonly BattlerId[];
}

/** コマンド入力の途中経過。 */
export interface InputCursor {
  /** `party` の中で今コマンドを選んでいるメンバー。 */
  readonly actorIndex: number;
  readonly menu: "command" | "skill" | "item" | "target";
  /** 今のメニューのカーソル位置（`target` では対象一覧の位置）。 */
  readonly index: number;
  /** 対象を選ぶ前に決めた行動（`target` のとき）。`from` は戻るときに復元する一つ前のメニューのカーソル。 */
  readonly pick: {
    readonly kind: "attack" | "skill" | "item";
    readonly skillId?: SkillId;
    readonly itemId?: ItemId;
    readonly from: number;
  } | null;
}

/** 画面に出すログ。文章にするのは runtime の投影（名前は `BattleState` から引く）。 */
export type BattleLogEntry =
  | { readonly kind: "appear"; readonly troop: TroopId }
  | { readonly kind: "turn"; readonly turn: number }
  | { readonly kind: "action"; readonly subject: BattlerId; readonly action: BattleActionKind; readonly skillId?: SkillId; readonly itemId?: ItemId }
  | { readonly kind: "damage"; readonly target: BattlerId; readonly amount: number; readonly critical: boolean }
  | { readonly kind: "heal"; readonly target: BattlerId; readonly stat: "hp" | "mp"; readonly amount: number }
  | { readonly kind: "miss"; readonly target: BattlerId }
  | { readonly kind: "defeated"; readonly target: BattlerId }
  | { readonly kind: "revived"; readonly target: BattlerId }
  | { readonly kind: "state"; readonly target: BattlerId; readonly state: StateId; readonly added: boolean }
  | { readonly kind: "buff"; readonly target: BattlerId; readonly param: BuffParam; readonly level: number }
  | { readonly kind: "cannotAct"; readonly subject: BattlerId; readonly reason: "dead" | "state" | "mp" | "item" | "skill" }
  | { readonly kind: "escape"; readonly success: boolean }
  | { readonly kind: "victory" }
  | { readonly kind: "defeat" }
  | { readonly kind: "rewards"; readonly exp: number; readonly gold: number; readonly items: readonly ItemId[] }
  | { readonly kind: "levelUp"; readonly actor: BattlerId; readonly level: number };

/** ダメージなどの数字の一時表示。`ttl` は残りフレーム数で、毎フレーム減って 0 で消える。 */
export interface BattlePopup {
  readonly target: BattlerId;
  readonly kind: "damage" | "critical" | "heal" | "miss";
  readonly amount: number;
  readonly ttl: number;
}

export interface BattleResult {
  readonly outcome: BattleOutcome;
  readonly exp: number;
  readonly gold: number;
  readonly drops: readonly ItemId[];
}

export interface BattleState {
  readonly troopId: TroopId;
  readonly phase: BattlePhase;
  readonly turn: number;
  readonly enemies: Readonly<Record<BattlerId, EnemyBattler>>;
  /** 敵の並び順（表示・対象選択の順序。`enemies` のキー順に頼らない）。 */
  readonly enemyOrder: readonly BattlerId[];
  /** 味方（パーティ）。HP/MP は戦闘の終わりに `GameState.actors` へ書き戻す。 */
  readonly allies: Readonly<Record<BattlerId, Battler>>;
  /** 戦闘に出る味方の順序（`ActorId`）。 */
  readonly party: readonly BattlerId[];
  readonly inputCursor: InputCursor;
  /** 入力済みの行動（`input` の間に溜まり、確定すると `queue` になる）。 */
  readonly actions: readonly BattleAction[];
  /** 敏捷順にソート済みの、これから解決する行動。 */
  readonly queue: readonly BattleAction[];
  /** このターン防御している戦闘者。 */
  readonly guarding: readonly BattlerId[];
  readonly log: readonly BattleLogEntry[];
  readonly popups: readonly BattlePopup[];
  readonly canEscape: boolean;
  readonly canLose: boolean;
  /** 戦闘専用の乱数（`fork`）。マップの乱数列には影響しない。 */
  readonly rng: RandomState;
  /** 次の処理までの待ちフレーム数（行動の間・結果表示の最低時間）。 */
  readonly wait: number;
  /** 終了フェーズ（victory / defeat / escape / aborted）に入ったときの結果。 */
  readonly result: BattleResult | null;
  /** もう動いた、敵グループのバトルイベントのページ（`Troop.pages` の番号）。どのページも 1 回の戦闘で 1 回だけ動く。 */
  readonly eventPagesRun?: readonly number[];
}

export interface DamageResult {
  /** 正なら HP ダメージ、負なら HP 回復。 */
  readonly amount: number;
  readonly critical: boolean;
  readonly hit: boolean;
}
