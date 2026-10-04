import type { GameState } from "../state.js";
import type { Battler, BattleLogEntry, BattlePopup, BattleState, BattlerId, EnemyBattler } from "./state.js";
import { isEnemyId } from "./battlers.js";

/** ログに残す最大件数（古いものから捨てる）。 */
export const LOG_MAX = 32;
/** ダメージ数字などを出しておくフレーム数。 */
export const POPUP_TTL = 45;

export function getBattler(b: BattleState, id: BattlerId): Battler | EnemyBattler | undefined {
  if (isEnemyId(id)) return Object.hasOwn(b.enemies, id) ? b.enemies[id] : undefined;
  return Object.hasOwn(b.allies, id) ? b.allies[id] : undefined;
}

export function setBattler(b: BattleState, battler: Battler | EnemyBattler): BattleState {
  if (isEnemyId(battler.id)) return { ...b, enemies: { ...b.enemies, [battler.id]: battler as EnemyBattler } };
  return { ...b, allies: { ...b.allies, [battler.id]: battler } };
}

/** 生死・順序を問わず、戦闘者を「味方（パーティ順）→ 敵（並び順）」の順に返す。まだ出ていない敵（`hidden`。増援）は含めない。 */
export function allBattlers(b: BattleState): Battler[] {
  const out: Battler[] = [];
  for (const id of b.party) {
    const ally = b.allies[id];
    if (ally !== undefined) out.push(ally);
  }
  for (const id of b.enemyOrder) {
    const enemy = b.enemies[id];
    if (enemy !== undefined && !enemy.hidden) out.push(enemy);
  }
  return out;
}

export const partyBattlers = (b: BattleState): Battler[] => b.party.flatMap((id) => (b.allies[id] === undefined ? [] : [b.allies[id]]));
/** 場に出ている敵（並び順）。まだ出ていない敵（`hidden`。増援）は含めない。 */
export const enemyBattlers = (b: BattleState): EnemyBattler[] => b.enemyOrder.flatMap((id) => (b.enemies[id] === undefined || b.enemies[id].hidden ? [] : [b.enemies[id]]));

/** 実効パラメータでの `Record<BattlerId, Battler>`（行動順の計算用）。 */
export function battlerTable(b: BattleState): Record<BattlerId, Battler> {
  return Object.fromEntries(allBattlers(b).map((x) => [x.id, x]));
}

function popupsFor(entries: readonly BattleLogEntry[]): BattlePopup[] {
  const out: BattlePopup[] = [];
  for (const e of entries) {
    if (e.kind === "damage") out.push({ target: e.target, kind: e.critical ? "critical" : "damage", amount: e.amount, ttl: POPUP_TTL });
    else if (e.kind === "heal" && e.stat === "hp") out.push({ target: e.target, kind: "heal", amount: e.amount, ttl: POPUP_TTL });
    else if (e.kind === "miss") out.push({ target: e.target, kind: "miss", amount: 0, ttl: POPUP_TTL });
  }
  return out;
}

/** ログを追記し（古いものは捨てる）、ダメージなどの数字の表示を足す。 */
export function commitLog(b: BattleState, entries: readonly BattleLogEntry[]): BattleState {
  if (entries.length === 0) return b;
  return { ...b, log: [...b.log, ...entries].slice(-LOG_MAX), popups: [...b.popups, ...popupsFor(entries)] };
}

export const withBattle = (state: GameState, battle: BattleState): GameState => ({ ...state, battle });
