import { enemyIdSchema, nonNegativeInt } from "@rpg/schema";
import * as z from "zod";
import { effectiveParam, markAborted, memberBattlerId } from "../../battle/index.js";
import { warn } from "../../effects.js";
import type { GameState } from "../../state.js";
import { defineCommand } from "../handler.js";
import type { CommandCtx } from "../handler.js";

/** 戦闘中の、敵グループの `member` 番目の敵。戦闘中でない・いないときは警告を返す。 */
function enemyAt(c: CommandCtx, code: string, member: number) {
  const b = c.state.battle;
  if (c.state.scene.kind !== "battle" || b === undefined) return { error: warn(`${code}: 戦闘中にしか使えない`) } as const;
  const enemy = b.enemies[memberBattlerId(member)];
  if (enemy === undefined) return { error: warn(`${code}: 敵グループに ${member} 番目の敵がいない`) } as const;
  return { battle: b, enemy } as const;
}

const withEnemy = (state: GameState, enemy: NonNullable<GameState["battle"]>["enemies"][string]): GameState => ({
  ...state,
  battle: { ...state.battle!, enemies: { ...state.battle!.enemies, [enemy.id]: enemy } },
});

const memberLabel = (member: number): string => `${member + 1} 番目の敵`;

/** 隠れている敵（`Troop.members[].hidden`）を出す（増援）。出ている敵には何もしない。 */
export const enemyAppear = defineCommand({
  code: "EnemyAppear",
  params: z.strictObject({ member: nonNegativeInt }),
  meta: {
    label: "敵の出現",
    category: "戦闘",
    describe: (p) => `敵の出現：${memberLabel(p.member)}`,
    refs: () => [],
  },
  run(p, c) {
    const found = enemyAt(c, "EnemyAppear", p.member);
    if ("error" in found) return { effects: [found.error] };
    if (!found.enemy.hidden) return {};
    return { state: withEnemy(c.state, { ...found.enemy, hidden: false }) };
  },
});

/**
 * 敵を別の敵に変える（変身）。名前・能力値・行動・報酬は変身後の敵のもの。HP と MP は、最大値に対する割合を保つ。
 * 状態異常と強化/弱体はそのまま。同じ種類が複数いて付いていた A, B… は残す。
 */
export const enemyTransform = defineCommand({
  code: "EnemyTransform",
  params: z.strictObject({ member: nonNegativeInt, enemy: enemyIdSchema }),
  meta: {
    label: "敵の変身",
    category: "戦闘",
    describe: (p, view) => `敵の変身：${memberLabel(p.member)} → ${view.project.database.enemies[p.enemy]?.name ?? p.enemy}`,
    refs: (p) => [{ kind: "enemy", id: p.enemy }],
  },
  run(p, c) {
    const found = enemyAt(c, "EnemyTransform", p.member);
    if ("error" in found) return { effects: [found.error] };
    const def = c.project.enemy(p.enemy);
    if (def === undefined) return { effects: [warn(`EnemyTransform: 敵 ${p.enemy} が存在しない`)] };
    const { enemy } = found;
    const oldBase = c.project.enemy(enemy.enemyId)?.name ?? enemy.enemyId;
    const suffix = enemy.name.startsWith(oldBase) ? enemy.name.slice(oldBase.length) : "";
    const hpRate = enemy.hp / Math.max(1, effectiveParam(c, enemy, "mhp"));
    const mpRate = enemy.mp / Math.max(1, effectiveParam(c, enemy, "mmp"));
    const next = { ...enemy, enemyId: def.id, name: `${def.name}${suffix}`, params: def.params };
    const hp = enemy.hp <= 0 ? 0 : Math.max(1, Math.round(effectiveParam(c, next, "mhp") * hpRate));
    const mp = Math.round(effectiveParam(c, next, "mmp") * mpRate);
    return { state: withEnemy(c.state, { ...next, hp, mp }) };
  },
});

/** 戦闘を中断する（結果は「中断」。戦闘の処理の分岐では逃走と同じ）。バトルイベントが終わったところで戦闘から抜ける。 */
export const abortBattleCommand = defineCommand({
  code: "AbortBattle",
  params: z.strictObject({}),
  meta: {
    label: "戦闘の中断",
    category: "戦闘",
    describe: () => "戦闘の中断",
    refs: () => [],
  },
  run(_p, c) {
    if (c.state.scene.kind !== "battle" || c.state.battle === undefined) return { effects: [warn("AbortBattle: 戦闘中にしか使えない")] };
    return { state: markAborted(c.state) };
  },
});
