import type { ActorId, ItemId, Skill, SkillId, TroopId } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import { warn } from "../effects.js";
import type { Effect } from "../effects.js";
import type { InputFrame } from "../input.js";
import { createRandom, restoreRandom } from "../random.js";
import type { GameState } from "../state.js";
import type { StepResult } from "../game/actions.js";
import { chooseEnemyAction } from "./ai.js";
import {
  allyBattler,
  ATTACK_SKILL,
  BATTLE_PARTY_MAX,
  canAct,
  effective,
  effectiveParam,
  enemyBattler,
  hasRestriction,
  isAlive,
  ITEM_SCOPE,
  learnedSkills,
  usableItems,
} from "./battlers.js";
import type { ProjectCtx } from "./battlers.js";
import { allBattlers, commitLog, enemyBattlers, getBattler, partyBattlers, withBattle } from "./helpers.js";
import { applyRewards } from "./rewards.js";
import { changeHp, resolveAction } from "./resolve.js";
import { defaultBattleRules } from "./rules.js";
import type { Battler, BattleAction, BattleLogEntry, BattleOutcome, BattleState, BattlerId, EnemyBattler, InputCursor } from "./state.js";

/** 行動を解決するたびに置く間（フレーム）。決定ボタンで飛ばせる。 */
export const ACTION_WAIT = 30;
/** コマンド入力を終えてから最初の行動が始まるまでの間（フレーム）。 */
export const TURN_START_WAIT = 10;
/** 結果（勝利・敗北・逃走）を出してから、決定を受け付けるまでの最低時間（フレーム）。 */
export const END_WAIT = 30;

/** 味方のコマンド（この順がカーソルの意味）。逃走は `canEscape` のときだけ並ぶ。 */
export const BATTLE_COMMANDS = ["attack", "skill", "item", "guard", "escape"] as const;
export type BattleCommand = (typeof BATTLE_COMMANDS)[number];
export const battleCommands = (canEscape: boolean): BattleCommand[] => (canEscape ? [...BATTLE_COMMANDS] : BATTLE_COMMANDS.filter((c) => c !== "escape"));

export type BattleVerdict = "ongoing" | "victory" | "defeat";

/** 敵全滅で `victory`、味方全滅で `defeat`。両方同時は `defeat`。 */
export function battleOutcome(b: BattleState): BattleVerdict {
  if (!partyBattlers(b).some(isAlive)) return "defeat";
  if (!enemyBattlers(b).some(isAlive)) return "victory";
  return "ongoing";
}

const idle = (state: GameState): StepResult => ({ state, effects: [] });
const wrap = (n: number, size: number): number => (size <= 0 ? 0 : ((n % size) + size) % size);

// ---- 開始 ----

/**
 * 戦闘を始める：戦闘シーンにして `BattleState` を作る（敵の名前は同じ種類が複数いれば A, B… を付ける）。
 * 戦闘の乱数は `seed` と `tick` から作る独立ストリームで、マップの乱数には触れない。エンカウントの歩数（`map.encounterSteps`）は 0 に戻す。
 * トループが存在しなければ何もしない。BGM は呼び出し側（BattleProcessing）が鳴らす。
 */
export function startBattle(state: GameState, troopId: TroopId, opts: { canEscape: boolean; canLose: boolean }, ctx: ProjectCtx): GameState {
  const troop = ctx.project.troop(troopId);
  if (troop === undefined) return state;

  const partyIds: ActorId[] = [];
  const allies: Record<BattlerId, Battler> = {};
  for (const id of state.party.members.slice(0, BATTLE_PARTY_MAX)) {
    const ally = allyBattler(state, ctx, id);
    if (ally === undefined) continue;
    partyIds.push(id);
    allies[id] = ally;
  }

  const totals = new Map<string, number>();
  for (const m of troop.members) totals.set(m.enemy, (totals.get(m.enemy) ?? 0) + 1);
  const seen = new Map<string, number>();
  const enemies: Record<BattlerId, EnemyBattler> = {};
  const enemyOrder: BattlerId[] = [];
  troop.members.forEach((m, index) => {
    const base = ctx.project.enemy(m.enemy)?.name ?? m.enemy;
    const n = seen.get(m.enemy) ?? 0;
    seen.set(m.enemy, n + 1);
    const name = (totals.get(m.enemy) ?? 0) > 1 ? `${base}${String.fromCharCode(65 + (n % 26))}` : base;
    const battler = enemyBattler(ctx, index, m, name);
    if (battler === undefined) return;
    enemies[battler.id] = battler;
    enemyOrder.push(battler.id);
  });

  const battle: BattleState = {
    troopId,
    phase: "start",
    turn: 0,
    enemies,
    enemyOrder,
    allies,
    party: partyIds,
    inputCursor: { actorIndex: 0, menu: "command", index: 0, pick: null },
    actions: [],
    queue: [],
    guarding: [],
    log: [],
    popups: [],
    canEscape: opts.canEscape,
    canLose: opts.canLose,
    rng: createRandom(state.rng.seed).fork(`battle:${state.tick}`).serialize(),
    wait: 0,
    result: null,
  };
  // 戦闘を始めると、ランダムエンカウントの歩数は数え直す（勝っても逃げても、直後はしばらく遭遇しない）
  return { ...state, scene: { kind: "battle" }, map: { ...state.map, encounterSteps: 0 }, battle };
}

// ---- ターンの進行 ----

/** `from` 以降で最初に行動を入力できる味方の位置。無ければ -1。 */
function nextActor(b: BattleState, ctx: Ctx, from: number): number {
  for (let i = from; i < b.party.length; i++) {
    const ally = b.allies[b.party[i]!];
    if (ally !== undefined && canAct(ctx, ally)) return i;
  }
  return -1;
}

/** 入力を確定する：入力できなかった味方と敵の行動を足し、敏捷順に並べて解決フェーズへ。 */
function finalizeInput(state: GameState, ctx: Ctx): GameState {
  const b = state.battle!;
  const rng = restoreRandom(b.rng);
  const actions: BattleAction[] = [...b.actions];
  for (const id of b.party) {
    const ally = b.allies[id];
    // 行動を制限された味方は何もできない（解決時に `cannotAct` が残る）
    if (ally !== undefined && isAlive(ally) && hasRestriction(ctx, ally)) actions.push({ subject: id, kind: "attack", targets: [] });
  }
  for (const enemy of enemyBattlers(b)) if (isAlive(enemy)) actions.push(chooseEnemyAction(enemy, state, ctx, rng));

  const table = Object.fromEntries(allBattlers(b).map((x) => [x.id, effective(ctx, x)]));
  const queue = (ctx.battleRules ?? defaultBattleRules).sortQueue(actions, table, rng);
  return withBattle(state, { ...b, phase: "resolve", actions: [], queue, wait: TURN_START_WAIT, rng: rng.serialize() });
}

/** 新しいターンを始める。入力できる味方がいなければそのまま解決へ進む。 */
function beginTurn(state: GameState, ctx: Ctx): GameState {
  const b = state.battle!;
  const turn = b.turn + 1;
  const first = nextActor(b, ctx, 0);
  const next: BattleState = commitLog(
    {
      ...b,
      turn,
      phase: "input",
      actions: [],
      queue: [],
      guarding: [],
      wait: 0,
      inputCursor: { actorIndex: Math.max(0, first), menu: "command", index: 0, pick: null },
    },
    [{ kind: "turn", turn }],
  );
  const s = withBattle(state, next);
  return first < 0 ? finalizeInput(s, ctx) : s;
}

/** ターンの終わり：状態による HP 増減 → 状態の残りターンを減らして解除 → 防御を解く。 */
function endTurn(state: GameState, ctx: Ctx): StepResult {
  let b = state.battle!;
  const log: BattleLogEntry[] = [];
  for (const original of allBattlers(b)) {
    let battler = getBattler(b, original.id)!;
    if (!isAlive(battler)) continue;
    let delta = 0;
    for (const entry of battler.states) delta += Math.trunc(effectiveParam(ctx, battler, "mhp") * -(ctx.project.state(entry.id)?.hpRegen ?? 0));
    if (delta !== 0) battler = changeHp(ctx, battler, delta, log);
    if (isAlive(battler)) {
      const kept = [];
      for (const entry of battler.states) {
        if (entry.turns <= 0) kept.push(entry);
        else if (entry.turns > 1) kept.push({ ...entry, turns: entry.turns - 1 });
        else log.push({ kind: "state", target: battler.id, state: entry.id, added: false });
      }
      battler = { ...battler, states: kept };
    }
    b = battler.id.startsWith("e:") ? { ...b, enemies: { ...b.enemies, [battler.id]: battler as BattleState["enemies"][string] } } : { ...b, allies: { ...b.allies, [battler.id]: battler } };
  }
  b = commitLog({ ...b, guarding: [] }, log);
  const s = withBattle(state, b);
  const verdict = battleOutcome(b);
  return verdict === "ongoing" ? idle(beginTurn(s, ctx)) : enterEnd(s, ctx, verdict);
}

/** 戦闘者の HP/MP を `GameState.actors` に書き戻す。 */
function syncAllies(state: GameState): GameState {
  const b = state.battle!;
  const actors = { ...state.actors };
  for (const id of b.party) {
    const ally = b.allies[id];
    const actor = Object.hasOwn(actors, id) ? actors[id as ActorId] : undefined;
    if (ally === undefined || actor === undefined) continue;
    actors[actor.id] = { ...actor, hp: Math.min(ally.hp, ally.params.mhp), mp: Math.min(ally.mp, ally.params.mmp) };
  }
  return { ...state, actors };
}

/** 勝敗・逃走が決まった：HP/MP を書き戻し、勝利なら報酬を反映して、結果表示のフェーズに入る。 */
function enterEnd(state: GameState, ctx: Ctx, outcome: Exclude<BattleOutcome, "aborted">): StepResult {
  let s = syncAllies(state);
  const entries: BattleLogEntry[] = [];
  let result = { outcome, exp: 0, gold: 0, drops: [] as ItemId[] };
  if (outcome === "victory") {
    entries.push({ kind: "victory" });
    const troop = ctx.project.troop(s.battle!.troopId);
    if (troop !== undefined) {
      const r = applyRewards(s, troop, ctx);
      s = r.state;
      result = { outcome, exp: r.exp, gold: r.gold, drops: r.drops };
      entries.push({ kind: "rewards", exp: r.exp, gold: r.gold, items: r.drops });
      for (const up of r.levelUps) entries.push({ kind: "levelUp", actor: up.actor, level: up.level });
    }
  } else if (outcome === "defeat") {
    entries.push({ kind: "defeat" });
  }
  const b = commitLog({ ...s.battle!, phase: outcome, queue: [], actions: [], wait: END_WAIT, result }, entries);
  return idle(withBattle(s, b));
}

/**
 * 結果表示を終えて戦闘から出る。
 * - 敗北かつ `canLose` でない：ゲームオーバー。
 * - それ以外：マップに戻る。戦闘不能の味方は HP 1 で復帰（メニューに回復手段が無い間の措置）。
 *   結果は待っているインタプリタ（BattleProcessing）の `locals.battleResult` に渡す。
 */
export function leaveBattle(state: GameState, ctx: Ctx): StepResult {
  const b = state.battle;
  if (b === undefined) return idle(state);
  const outcome = b.result?.outcome ?? "aborted";
  const { battle: _battle, ...rest } = state;
  const effects: Effect[] = ctx.project.project.system.bgm.battle === undefined ? [] : [{ kind: "stopBgm", fadeMs: 500 }];

  if (outcome === "defeat" && !b.canLose) {
    return { state: { ...rest, scene: { kind: "gameover" } }, effects: [{ kind: "stopBgm", fadeMs: 500 }] };
  }

  const actors = { ...rest.actors };
  for (const id of b.party) {
    const actor = Object.hasOwn(actors, id) ? actors[id as ActorId] : undefined;
    if (actor !== undefined && actor.hp <= 0) actors[actor.id] = { ...actor, hp: 1 };
  }
  const interpreters = rest.interpreters.map((i) => (i.wait.kind === "battle" ? { ...i, locals: { ...i.locals, battleResult: outcome } } : i));
  return { state: { ...rest, scene: { kind: "map" }, actors, interpreters }, effects };
}

/** 戦闘を中断して抜ける（結果は `aborted`）。 */
export function abortBattle(state: GameState, ctx: Ctx): StepResult {
  const b = state.battle;
  if (b === undefined) return idle(state);
  return leaveBattle(withBattle(syncAllies(state), { ...b, phase: "aborted", result: { outcome: "aborted", exp: 0, gold: 0, drops: [] } }), ctx);
}

// ---- 毎フレーム ----

/** 味方に対するダメージがあれば画面を揺らす。 */
function shakeFor(log: readonly BattleLogEntry[]): Effect[] {
  return log.some((e) => e.kind === "damage" && e.amount > 0 && !e.target.startsWith("e:")) ? [{ kind: "screenShake", power: 4, durationTicks: 12 }] : [];
}

/** 行動を 1 つ解決する。倒れた戦闘者の行動は黙って飛ばす。 */
function act(state: GameState, ctx: Ctx): StepResult {
  const b = state.battle!;
  const [action, ...rest] = b.queue;
  if (action === undefined) return idle(state);
  const s = withBattle(state, { ...b, queue: rest });
  const subject = getBattler(b, action.subject);
  if (subject === undefined || !isAlive(subject)) return idle(s);

  const r = resolveAction(s, action, ctx);
  const committed = commitLog(r.state.battle!, r.log);
  const next = withBattle(r.state, { ...committed, wait: ACTION_WAIT });
  const effects: Effect[] = [...r.warnings.map(warn), ...shakeFor(r.log)];
  if (committed.phase === "escape") {
    const ended = enterEnd(next, ctx, "escape");
    return { state: ended.state, effects };
  }
  const verdict = battleOutcome(committed);
  if (verdict === "ongoing") return { state: next, effects };
  const ended = enterEnd(next, ctx, verdict);
  return { state: ended.state, effects };
}

/** 戦闘シーンの 1 フレーム分の時間経過。 */
export function battleTick(state: GameState, ctx: Ctx): StepResult {
  const b0 = state.battle;
  if (b0 === undefined) return idle(state);
  const popups = b0.popups.flatMap((p) => (p.ttl > 1 ? [{ ...p, ttl: p.ttl - 1 }] : []));
  const b: BattleState = b0.popups.length === 0 ? b0 : { ...b0, popups };
  const s = withBattle(state, b);

  switch (b.phase) {
    case "start":
      return idle(beginTurn(withBattle(s, commitLog(b, [{ kind: "appear", troop: b.troopId }])), ctx));
    case "input":
      return idle(s);
    case "resolve":
      if (b.wait > 0) return idle(withBattle(s, { ...b, wait: b.wait - 1 }));
      if (b.queue.length === 0) return endTurn(s, ctx);
      return act(s, ctx);
    default:
      return b.wait > 0 ? idle(withBattle(s, { ...b, wait: b.wait - 1 })) : idle(s);
  }
}

// ---- 入力 ----

/** 対象を選ぶスキル/アイテムの範囲。 */
function pickScope(ctx: Ctx, pick: NonNullable<InputCursor["pick"]>): Skill["scope"] {
  if (pick.kind === "attack") return ATTACK_SKILL.scope;
  if (pick.kind === "item") return ITEM_SCOPE;
  return (pick.skillId === undefined ? undefined : ctx.project.skill(pick.skillId))?.scope ?? "none";
}

/** 対象選択メニューに並ぶ戦闘者（一人を選ぶ範囲のときだけ）。 */
export function targetCandidates(b: BattleState, scope: Skill["scope"]): BattlerId[] {
  switch (scope) {
    case "one-enemy":
      return enemyBattlers(b).filter(isAlive).map((x) => x.id);
    case "one-ally":
      return partyBattlers(b).filter(isAlive).map((x) => x.id);
    case "one-dead-ally":
      return partyBattlers(b).filter((x) => !isAlive(x)).map((x) => x.id);
    default:
      return [];
  }
}

const isSingle = (scope: Skill["scope"]): boolean => scope === "one-enemy" || scope === "one-ally" || scope === "one-dead-ally";

function actionFrom(subject: BattlerId, pick: NonNullable<InputCursor["pick"]>, targets: readonly BattlerId[]): BattleAction {
  return {
    subject,
    kind: pick.kind,
    ...(pick.skillId === undefined ? {} : { skillId: pick.skillId as SkillId }),
    ...(pick.itemId === undefined ? {} : { itemId: pick.itemId as ItemId }),
    targets,
  };
}

/** 入力済みの行動を足して、次の味方へ（全員済んだら確定して解決フェーズへ）。 */
function commit(state: GameState, ctx: Ctx, action: BattleAction): StepResult {
  const b = state.battle!;
  const withAction: BattleState = { ...b, actions: [...b.actions, action] };
  const next = nextActor(withAction, ctx, b.inputCursor.actorIndex + 1);
  if (next < 0) return idle(finalizeInput(withBattle(state, withAction), ctx));
  return idle(withBattle(state, { ...withAction, inputCursor: { actorIndex: next, menu: "command", index: 0, pick: null } }));
}

/** 対象が要る範囲なら対象選択へ、そうでなければそのまま行動を確定する。 */
function pickOrCommit(state: GameState, ctx: Ctx, actorId: BattlerId, pick: NonNullable<InputCursor["pick"]>): StepResult {
  const b = state.battle!;
  const scope = pickScope(ctx, pick);
  if (!isSingle(scope)) return commit(state, ctx, actionFrom(actorId, pick, []));
  if (targetCandidates(b, scope).length === 0) return idle(state);
  return idle(withBattle(state, { ...b, inputCursor: { ...b.inputCursor, menu: "target", index: 0, pick } }));
}

function inputPhase(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const b = state.battle!;
  const cur = b.inputCursor;
  const actorId = b.party[cur.actorIndex];
  const ally = actorId === undefined ? undefined : b.allies[actorId];
  if (actorId === undefined || ally === undefined) return idle(state);

  const ok = input.triggered.has("ok");
  const cancel = input.triggered.has("cancel");
  const dy = (input.triggered.has("down") ? 1 : 0) - (input.triggered.has("up") ? 1 : 0);
  const dx = (input.triggered.has("right") ? 1 : 0) - (input.triggered.has("left") ? 1 : 0);
  const setCursor = (c: Partial<InputCursor>): StepResult => idle(withBattle(state, { ...b, inputCursor: { ...cur, ...c } }));
  const commands = battleCommands(b.canEscape);

  switch (cur.menu) {
    case "command": {
      if (dy !== 0) return setCursor({ index: wrap(cur.index + dy, commands.length) });
      if (cancel) {
        // 一つ前の味方のコマンド選び直し
        let prev = -1;
        for (let i = cur.actorIndex - 1; i >= 0; i--) {
          const p = b.allies[b.party[i]!];
          if (p !== undefined && canAct(ctx, p)) {
            prev = i;
            break;
          }
        }
        if (prev < 0) return idle(state);
        const last = b.actions[b.actions.length - 1];
        const actions = last?.subject === b.party[prev] ? b.actions.slice(0, -1) : b.actions;
        return idle(withBattle(state, { ...b, actions, inputCursor: { actorIndex: prev, menu: "command", index: 0, pick: null } }));
      }
      if (!ok) return idle(state);
      const command = commands[cur.index];
      switch (command) {
        case "attack":
          return pickOrCommit(state, ctx, actorId, { kind: "attack", from: cur.index });
        case "skill":
          return learnedSkills(ctx, actorId as ActorId, ally.level).length === 0 ? idle(state) : setCursor({ menu: "skill", index: 0 });
        case "item":
          return usableItems(state, ctx).length === 0 ? idle(state) : setCursor({ menu: "item", index: 0 });
        case "guard":
          return commit(state, ctx, { subject: actorId, kind: "guard", targets: [] });
        case "escape":
          return commit(state, ctx, { subject: actorId, kind: "escape", targets: [] });
        default:
          return idle(state);
      }
    }
    case "skill": {
      const list = learnedSkills(ctx, actorId as ActorId, ally.level);
      if (cancel) return setCursor({ menu: "command", index: commands.indexOf("skill"), pick: null });
      if (dy !== 0) return setCursor({ index: wrap(cur.index + dy, list.length) });
      const skill = list[cur.index];
      if (!ok || skill === undefined || skill.mpCost > ally.mp) return idle(state);
      return pickOrCommit(state, ctx, actorId, { kind: "skill", skillId: skill.id, from: cur.index });
    }
    case "item": {
      const list = usableItems(state, ctx);
      if (cancel) return setCursor({ menu: "command", index: commands.indexOf("item"), pick: null });
      if (dy !== 0) return setCursor({ index: wrap(cur.index + dy, list.length) });
      const item = list[cur.index];
      if (!ok || item === undefined) return idle(state);
      return pickOrCommit(state, ctx, actorId, { kind: "item", itemId: item.id, from: cur.index });
    }
    case "target": {
      const pick = cur.pick;
      if (pick === null) return setCursor({ menu: "command", index: 0 });
      const candidates = targetCandidates(b, pickScope(ctx, pick));
      if (cancel) {
        const menu = pick.kind === "attack" ? "command" : pick.kind;
        return setCursor({ menu, index: pick.from, pick: null });
      }
      const delta = dx !== 0 ? dx : dy;
      if (delta !== 0) return setCursor({ index: wrap(cur.index + delta, candidates.length) });
      const target = candidates[cur.index];
      if (!ok || target === undefined) return idle(state);
      return commit(state, ctx, actionFrom(actorId, pick, [target]));
    }
  }
}

/**
 * 戦闘シーンの入力（時間は進めない）。コマンド入力は決定/キャンセル/十字キー、
 * 解決中の決定は待ちを飛ばし、結果表示中の決定/キャンセルで戦闘から出る。
 */
export function battleInput(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const b = state.battle;
  if (b === undefined) return idle(state);
  const ok = input.triggered.has("ok");
  switch (b.phase) {
    case "input":
      return inputPhase(state, input, ctx);
    case "resolve":
      return ok && b.wait > 0 ? idle(withBattle(state, { ...b, wait: 0 })) : idle(state);
    case "victory":
    case "defeat":
    case "escape":
    case "aborted":
      return (ok || input.triggered.has("cancel")) && b.wait <= 0 ? leaveBattle(state, ctx) : idle(state);
    default:
      return idle(state);
  }
}

/** 1 フレーム分（入力 → 時間経過）。`core.step` は入力と時間を別々に呼ぶが、戦闘単体のテスト用にまとめてある。 */
export function battleStep(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const a = battleInput(state, input, ctx);
  const b = state.scene.kind === "battle" && a.state.scene.kind === "battle" ? battleTick({ ...a.state, tick: a.state.tick + 1 }, ctx) : { state: a.state, effects: [] };
  return { state: b.state, effects: [...a.effects, ...b.effects] };
}
