import type { BuffParam, Item, Skill, SkillEffect, SkillId } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import { restoreRandom } from "../random.js";
import type { Random } from "../random.js";
import type { GameState } from "../state.js";
import { ATTACK_SKILL, clampBattler, effective, effectiveParam, hasRestriction, isAlive, isEnemyId, ITEM_SCOPE } from "./battlers.js";
import { calcDamage, isHostileScope } from "./damage.js";
import { enemyBattlers, getBattler, partyBattlers, setBattler } from "./helpers.js";
import { defaultBattleRules } from "./rules.js";
import type { Battler, BattleAction, BattleLogEntry, BattleState, BattlerId } from "./state.js";

export interface ResolveResult {
  readonly state: GameState;
  /** 起きたことの記録（`battle.log` への追記とポップアップは呼び出し側が行う）。 */
  readonly log: BattleLogEntry[];
  /** 続行はできるが注意が要ること（式が評価できない、戦闘中に未対応の効果など）。 */
  readonly warnings: string[];
}

const BUFF_MIN = -2;
const BUFF_MAX = 2;

/** 使う側から見た「敵」と「味方」の並び（生死を問わない）。 */
function sides(b: BattleState, subject: BattlerId): { foes: Battler[]; friends: Battler[] } {
  return isEnemyId(subject) ? { foes: partyBattlers(b), friends: enemyBattlers(b) } : { foes: enemyBattlers(b), friends: partyBattlers(b) };
}

/**
 * 行動の対象を範囲から決める。`chosen` は入力時に選んだ対象で、まだ有効ならそれを使い、
 * 倒れていたら同じ側の最初の有効な相手に差し替える。有効な対象がいなければ空。
 */
export function resolveTargets(b: BattleState, subject: BattlerId, scope: Skill["scope"], chosen: readonly BattlerId[]): BattlerId[] {
  const { foes, friends } = sides(b, subject);
  const ids = (xs: Battler[]): BattlerId[] => xs.map((x) => x.id);
  const alive = (xs: Battler[]): Battler[] => xs.filter(isAlive);
  const pickOne = (pool: Battler[]): BattlerId[] => {
    const wanted = pool.find((x) => x.id === chosen[0]);
    const target = wanted ?? pool[0];
    return target === undefined ? [] : [target.id];
  };
  switch (scope) {
    case "none":
      return [];
    case "self":
      return [subject];
    case "one-enemy":
      return pickOne(alive(foes));
    case "all-enemies":
      return ids(alive(foes));
    case "one-ally":
      return pickOne(alive(friends));
    case "all-allies":
      return ids(alive(friends));
    case "one-dead-ally":
      return pickOne(friends.filter((x) => !isAlive(x)));
  }
}

const clampBuff = (n: number): number => Math.min(Math.max(n, BUFF_MIN), BUFF_MAX);

/** 目標に対する 1 つの効果の適用結果（戦闘者の更新・ログ・警告）。 */
interface Applied {
  battler: Battler;
  log: BattleLogEntry[];
  warnings: string[];
}

function defeat(b: Battler, log: BattleLogEntry[]): Battler {
  log.push({ kind: "defeated", target: b.id });
  return { ...b, hp: 0, states: [], buffs: {} };
}

/** HP を増減して 0 になったら戦闘不能にする。 */
export function changeHp(ctx: Ctx, b: Battler, delta: number, log: BattleLogEntry[], opts: { critical?: boolean } = {}): Battler {
  const mhp = effectiveParam(ctx, b, "mhp");
  if (delta > 0) {
    // ダメージ
    const hp = Math.max(0, b.hp - delta);
    log.push({ kind: "damage", target: b.id, amount: delta, critical: opts.critical === true });
    const next = { ...b, hp };
    return hp === 0 ? defeat(next, log) : next;
  }
  if (delta < 0) {
    const hp = Math.min(mhp, b.hp - delta);
    const healed = hp - b.hp;
    if (healed > 0) log.push({ kind: "heal", target: b.id, stat: "hp", amount: healed });
    return { ...b, hp };
  }
  return b;
}

function applyEffect(ctx: Ctx, target: Battler, effect: SkillEffect, scope: Skill["scope"], rng: Random, log: BattleLogEntry[], warnings: string[]): Battler {
  switch (effect.kind) {
    case "recoverHp": {
      if (!isAlive(target)) {
        if (scope !== "one-dead-ally") return target;
        // 蘇生：戦闘不能の味方に使うと、指定量（最低 1）の HP で戻る
        const mhp = effectiveParam(ctx, target, "mhp");
        log.push({ kind: "revived", target: target.id });
        return { ...target, hp: Math.min(mhp, Math.max(1, Math.round(effect.value))) };
      }
      return changeHp(ctx, target, -Math.round(effect.value), log);
    }
    case "recoverMp": {
      if (!isAlive(target)) return target;
      const mmp = effectiveParam(ctx, target, "mmp");
      const mp = Math.min(mmp, Math.max(0, target.mp + Math.round(effect.value)));
      if (mp - target.mp > 0) log.push({ kind: "heal", target: target.id, stat: "mp", amount: mp - target.mp });
      return { ...target, mp };
    }
    case "addState": {
      if (!isAlive(target)) return target;
      const def = ctx.project.state(effect.state);
      if (def === undefined) {
        warnings.push(`未定義の状態 ${effect.state} を付与しようとした`);
        return target;
      }
      // 確率 1 のときは乱数を引かない（確実な効果で乱数列を動かさない）
      if (effect.chance < 1 && rng.next() >= effect.chance) return target;
      const had = target.states.some((s) => s.id === effect.state);
      const entry = { id: effect.state, turns: def.turns };
      const states = had ? target.states.map((s) => (s.id === effect.state ? entry : s)) : [...target.states, entry];
      if (!had) log.push({ kind: "state", target: target.id, state: effect.state, added: true });
      return { ...target, states };
    }
    case "removeState": {
      if (!target.states.some((s) => s.id === effect.state)) return target;
      log.push({ kind: "state", target: target.id, state: effect.state, added: false });
      return { ...target, states: target.states.filter((s) => s.id !== effect.state) };
    }
    case "buff": {
      if (!isAlive(target)) return target;
      const param: BuffParam = effect.param;
      const before = target.buffs[param] ?? 0;
      const after = clampBuff(before + effect.level);
      if (after === before) return target;
      log.push({ kind: "buff", target: target.id, param, level: after });
      return { ...target, buffs: { ...target.buffs, [param]: after } };
    }
    case "commonEvent":
      warnings.push(`戦闘中のコモンイベント効果（${effect.id}）は未対応`);
      return target;
  }
}

/** 1 つの対象へのダメージ/回復（式）と追加効果をまとめて適用する。 */
function applyToTarget(
  state: GameState,
  ctx: Ctx,
  b: BattleState,
  subject: Battler,
  targetId: BattlerId,
  def: Skill | Item,
  scope: Skill["scope"],
  rng: Random,
  guarding: boolean,
): { battle: BattleState } & Pick<Applied, "log" | "warnings"> {
  const log: BattleLogEntry[] = [];
  const warnings: string[] = [];
  let target = getBattler(b, targetId);
  if (target === undefined) return { battle: b, log, warnings };
  const before = target;

  const hasFormula = (def.formula ?? "").trim() !== "";
  if (hasFormula && (isAlive(target) || scope === "one-dead-ally")) {
    const r = calcDamage(def, subject, target, ctx, rng, state);
    if (!r.ok) {
      warnings.push(`ダメージ式 "${def.formula}" を評価できない: ${r.error.message}`);
    } else if (!r.value.hit) {
      log.push({ kind: "miss", target: target.id });
    } else if (isAlive(target)) {
      let amount = r.value.amount;
      if (amount > 0 && guarding) amount = Math.max(1, Math.floor(amount / 2));
      target = changeHp(ctx, target, amount, log, { critical: r.value.critical });
    }
  }

  const missed = log.some((e) => e.kind === "miss");
  if (!missed) for (const effect of def.effects) target = applyEffect(ctx, target, effect, scope, rng, log, warnings);
  target = clampBattler(ctx, target);
  return { battle: target === before ? b : setBattler(b, target), log, warnings };
}

/**
 * 行動を 1 つ解決する。`subject` が戦闘不能・行動不能・MP/アイテム不足なら何も起こさず（`cannotAct` を残す）、
 * 逃走が成功したときは `phase` を `escape` にする。勝敗の判定と `battle.log` への追記は呼び出し側。
 * 乱数は `battle.rng` から進める（マップの乱数には触れない）。
 */
export function resolveAction(state: GameState, action: BattleAction, ctx: Ctx): ResolveResult {
  const battle = state.battle;
  const log: BattleLogEntry[] = [];
  const warnings: string[] = [];
  if (battle === undefined) return { state, log, warnings };

  const subject = getBattler(battle, action.subject);
  if (subject === undefined || !isAlive(subject)) {
    return { state, log: [{ kind: "cannotAct", subject: action.subject, reason: "dead" }], warnings };
  }
  if (hasRestriction(ctx, subject)) {
    return { state, log: [{ kind: "cannotAct", subject: action.subject, reason: "state" }], warnings };
  }

  const rules = ctx.battleRules ?? defaultBattleRules;
  const rng = restoreRandom(battle.rng);
  let b = battle;
  let game = state;

  const finish = (next: BattleState, nextGame: GameState = game): ResolveResult => ({
    state: { ...nextGame, battle: { ...next, rng: rng.serialize() } },
    log,
    warnings,
  });

  if (action.kind === "guard") {
    log.push({ kind: "action", subject: subject.id, action: "guard" });
    return finish(b.guarding.includes(subject.id) ? b : { ...b, guarding: [...b.guarding, subject.id] });
  }

  if (action.kind === "escape") {
    log.push({ kind: "action", subject: subject.id, action: "escape" });
    const party = partyBattlers(b).filter(isAlive).map((x) => effective(ctx, x));
    const enemies = enemyBattlers(b).filter(isAlive).map((x) => effective(ctx, x));
    const success = b.canEscape && rng.next() < rules.escapeRate(party, enemies);
    log.push({ kind: "escape", success });
    return finish(success ? { ...b, phase: "escape", queue: [] } : b);
  }

  // 攻撃・スキル・アイテム
  let def: Skill | Item;
  let scope: Skill["scope"];
  if (action.kind === "attack") {
    def = ATTACK_SKILL;
    scope = ATTACK_SKILL.scope;
  } else if (action.kind === "skill") {
    const skill = action.skillId === undefined ? undefined : ctx.project.skill(action.skillId as SkillId);
    if (skill === undefined) return { state, log: [{ kind: "cannotAct", subject: subject.id, reason: "skill" }], warnings };
    if (skill.mpCost > subject.mp) return { state, log: [{ kind: "cannotAct", subject: subject.id, reason: "mp" }], warnings };
    def = skill;
    scope = skill.scope;
  } else {
    const item = action.itemId === undefined ? undefined : ctx.project.item(action.itemId);
    const count = action.itemId === undefined || !Object.hasOwn(state.party.items, action.itemId) ? 0 : (state.party.items[action.itemId] ?? 0);
    if (item === undefined || count <= 0 || isEnemyId(subject.id)) {
      return { state, log: [{ kind: "cannotAct", subject: subject.id, reason: "item" }], warnings };
    }
    def = item;
    scope = ITEM_SCOPE;
    const items = { ...state.party.items };
    if (count <= 1) delete items[item.id];
    else items[item.id] = count - 1;
    game = { ...state, party: { ...state.party, items } };
  }

  log.push({
    kind: "action",
    subject: subject.id,
    action: action.kind,
    ...(action.skillId === undefined ? {} : { skillId: action.skillId }),
    ...(action.itemId === undefined ? {} : { itemId: action.itemId }),
  });

  let user = subject;
  if (action.kind === "skill" && def !== ATTACK_SKILL) {
    user = { ...subject, mp: subject.mp - (def as Skill).mpCost };
    b = setBattler(b, user);
  }

  const targets = resolveTargets(b, subject.id, scope, action.targets);
  for (const targetId of targets) {
    const applied = applyToTarget(game, ctx, b, user, targetId, def, scope, rng, b.guarding.includes(targetId) && isHostileScope(scope));
    b = applied.battle;
    log.push(...applied.log);
    warnings.push(...applied.warnings);
    // 自分自身が対象のとき、`user` を最新にしておく（後続の対象への計算に使う）
    if (targetId === user.id) user = getBattler(b, user.id) ?? user;
  }
  return finish(b);
}
