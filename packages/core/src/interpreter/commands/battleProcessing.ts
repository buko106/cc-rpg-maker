import { troopIdSchema } from "@rpg/schema";
import { z } from "zod";
import { startBattle } from "../../battle/index.js";
import { warn } from "../../effects.js";
import type { Effect } from "../../effects.js";
import { defineCommand } from "../handler.js";

const params = z.strictObject({
  troop: troopIdSchema,
  canEscape: z.boolean().default(true),
  canLose: z.boolean().default(false),
});

/** 戦闘の結果 → `ChoiceBranch` の番号（勝利 = 0、逃走 = 1、敗北 = 2）。中断は逃走と同じ扱い。 */
export const BATTLE_BRANCH: Readonly<Record<string, number>> = { victory: 0, escape: 1, aborted: 1, defeat: 2 };

/**
 * 戦闘を始めて、終わるまで待つ。終わったら結果（勝利 0 / 逃走 1 / 敗北 2）を `branch[indent]` に書き、
 * 続く `ChoiceBranch { index }` のうち該当するものだけが実行される（末尾は `EndBranch`）。
 * 敗北して `canLose` が偽ならゲームオーバーになり、このインタプリタは戻らない。
 * トループが無いときや、マップ以外のシーンでは警告してスキップする。戦闘 BGM（`system.bgm.battle`）もここで鳴らす。
 * セーブから復元したとき（戦闘の状態は保存されない）は、結果が無いので逃走の分岐に進む。
 */
export const battleProcessing = defineCommand({
  code: "BattleProcessing",
  params,
  meta: {
    label: "戦闘の処理",
    category: "ゲーム進行",
    describe: (p, view) =>
      `戦闘の処理：${view.project.database.troops[p.troop]?.name ?? p.troop}${p.canEscape ? "" : "（逃走不可）"}${p.canLose ? "（敗北可）" : ""}`,
    branchLabel: (_p, index) => ["勝ったとき", "逃げたとき", "負けたとき"][index] ?? `分岐 ${index}`,
    block: { role: "open", close: "EndBranch", bodyFirst: false, dividers: () => [0, 1, 2].map((index) => ({ code: "ChoiceBranch", params: { index } })) },
    refs: (p) => [{ kind: "troop", id: p.troop }],
  },
  run(p, c) {
    if (c.state.scene.kind !== "map") return { effects: [warn(`BattleProcessing: マップ以外（${c.state.scene.kind}）では戦闘を始められない`)] };
    if (c.project.troop(p.troop) === undefined) return { effects: [warn(`BattleProcessing: トループ ${p.troop} が存在しない`)] };
    const state = startBattle(c.state, p.troop, { canEscape: p.canEscape, canLose: p.canLose }, c);
    const bgm = c.project.project.system.bgm.battle;
    const effects: Effect[] = bgm === undefined ? [] : [{ kind: "playBgm", audio: bgm, fadeMs: 300 }];
    return { state, effects, control: { kind: "wait", wait: { kind: "battle" } } };
  },
  resume(_p, c) {
    // 戦闘中、またはゲームオーバー/タイトルに移った（このインタプリタは戻らない）間は待つ
    if (c.state.scene.kind !== "map") return { control: { kind: "wait", wait: c.interp.wait } };
    const result = c.interp.locals["battleResult"];
    const index = typeof result === "string" && Object.hasOwn(BATTLE_BRANCH, result) ? BATTLE_BRANCH[result]! : BATTLE_BRANCH["aborted"]!;
    return { setBranch: { [c.interp.commands[c.interp.pc]?.indent ?? 0]: index }, control: { kind: "next" } };
  },
});
