import { battleCommands, emptyInput, inputFrame, learnedSkills, step, targetCandidates, usableItems } from "@rpg/core";
import type { BattleOutcome, Battler, BattlerId, BattleState, Button, Ctx, GameState, InputFrame } from "@rpg/core";
import type { ActorId, Item, Skill } from "@rpg/schema";

/** 作戦が選ぶ行動。`target` は一人を選ぶ範囲のときの対象（省略・選べないときは先頭）。 */
export interface BattleChoice {
  kind: "attack" | "skill" | "item" | "guard";
  skill?: string;
  item?: string;
  target?: BattlerId;
}

/** 作戦に渡す、いまコマンドを選ぶ味方の情報。`skills` は習得済みのスキル（MP が足りないものも含む）、`items` は戦闘で使えるアイテム。 */
export interface BattleTurn {
  state: GameState;
  battle: BattleState;
  actor: Battler;
  skills: readonly Skill[];
  items: readonly Item[];
  ctx: Ctx;
}

/** 戦い方（作戦）。味方 1 人ぶんの行動を選ぶ。決定的であること（同じ状態なら同じ行動）。 */
export type BattlePolicy = (turn: BattleTurn) => BattleChoice;

const press = (...buttons: Button[]): InputFrame => inputFrame(buttons, buttons);

/**
 * 戦闘の 1 フレーム分の入力。`policy` が選ぶ行動を、人と同じメニューの操作（十字キーと決定）で入れる。
 * メッセージ（バトルイベント）は決定で送り（選択肢は先頭）、解決中と結果表示も決定で送る。選べない行動（MP 不足のスキルなど）は通常攻撃に読み替える。
 */
export function battleBotInput(state: GameState, ctx: Ctx, policy: BattlePolicy): InputFrame {
  // バトルイベントのメッセージだけを送る（戦闘の前からマップに出ていたメッセージは、戦闘の入力には関係ない）
  if (state.message.open && state.interpreters.some((i) => i.id === state.message.owner && i.origin.kind === "troop")) return press("ok");
  const b = state.battle;
  if (b === undefined) return emptyInput();
  if (b.phase !== "input") return b.phase === "start" ? emptyInput() : press("ok");
  const cur = b.inputCursor;
  const actorId = b.party[cur.actorIndex];
  const actor = actorId === undefined ? undefined : b.allies[actorId];
  if (actorId === undefined || actor === undefined) return emptyInput();
  const skills = learnedSkills(ctx, actorId as ActorId, actor.level);
  const items = usableItems(state, ctx);
  let choice = policy({ state, battle: b, actor, skills, items, ctx });
  const usable =
    choice.kind === "skill" ? skills.some((x) => x.id === choice.skill && x.mpCost <= actor.mp) : choice.kind === "item" ? items.some((x) => x.id === choice.item) : true;
  if (!usable) choice = { kind: "attack", ...(choice.target === undefined ? {} : { target: choice.target }) };
  /** カーソルを `want` に合わせる（合っていれば決定）。 */
  const toward = (want: number, next: Button = "down"): InputFrame => (want < 0 || cur.index === want ? press("ok") : press(next));
  switch (cur.menu) {
    case "command":
      return toward(battleCommands(b.canEscape).indexOf(choice.kind));
    case "skill":
      return choice.kind === "skill" ? toward(skills.findIndex((x) => x.id === choice.skill)) : press("cancel");
    case "item":
      return choice.kind === "item" ? toward(items.findIndex((x) => x.id === choice.item)) : press("cancel");
    case "target": {
      const pick = cur.pick;
      const scope = pick === null ? "none" : pick.kind === "attack" ? "one-enemy" : pick.kind === "item" ? "one-ally" : (ctx.project.skill(pick.skillId as never)?.scope ?? "none");
      const candidates = targetCandidates(b, scope);
      return toward(choice.target === undefined ? 0 : Math.max(0, candidates.indexOf(choice.target)), "right");
    }
  }
}

/** `runBattle` の結果。`turns` は戦闘が終わったときのターン数、`frames` はかかったフレーム数。 */
export interface BattleRun {
  /** 戦闘から出たあとの状態（マップ・ゲームオーバーなど）。 */
  state: GameState;
  outcome: BattleOutcome;
  turns: number;
  frames: number;
  /** 戦闘が終わった時点の味方（HP/MP の残りを見る）。 */
  party: readonly Battler[];
}

/**
 * 戦闘シーンを出るまで `policy` で戦う（`core.step` と同じ経路。バトルイベントも動く）。
 * `maxFrames` で終わらなければ例外（終わらない戦闘はデータの不具合として扱う）。
 */
export function runBattle(state: GameState, ctx: Ctx, policy: BattlePolicy, maxFrames = 30000): BattleRun {
  let s = state;
  let last: BattleState | undefined = s.battle;
  let frames = 0;
  for (; frames < maxFrames && s.scene.kind === "battle"; frames++) {
    s = step(s, battleBotInput(s, ctx, policy), ctx).state;
    if (s.battle !== undefined) last = s.battle;
  }
  if (s.scene.kind === "battle") throw new Error(`runBattle: ${maxFrames} フレームで戦闘が終わらない`);
  const party = last === undefined ? [] : last.party.flatMap((id) => (last.allies[id] === undefined ? [] : [last.allies[id]]));
  return { state: s, outcome: last?.result?.outcome ?? "aborted", turns: last?.turn ?? 0, frames, party };
}
