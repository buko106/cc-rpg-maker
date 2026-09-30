import { switchIdSchema, variableIdSchema } from "@rpg/schema";
import type { RefTarget } from "@rpg/schema";
import { z } from "zod";
import { warn } from "../../effects.js";
import { defineCommand } from "../handler.js";
import type { CommandCtx, CommandResult } from "../handler.js";
import { comparison, switchName, variableName } from "./params.js";

/**
 * 条件は構造化条件か、05 の式（文字列）。エディタは先頭の種類（スイッチ・ON）を新しい条件の既定にする。
 */
const condition = z.union([
  z.strictObject({ kind: z.literal("switch"), id: switchIdSchema, value: z.boolean().meta({ initial: true }) }),
  z.strictObject({ kind: z.literal("variable"), id: variableIdSchema, op: comparison, value: z.number() }),
  z.string().meta({ formula: true }),
]);

const params = z.strictObject({ condition });
type Params = z.output<typeof params>;

/**
 * 条件分岐。真なら次の命令へ進み、偽なら同じ indent の次の `Else` / `EndBranch` まで飛ぶ。
 * 選択された側を `branch[indent]` に書く（真 = 0、偽 = 1）。`Else` がそれを見て本体を実行するか飛ばすかを決める。
 * 式が評価できない・真偽値でないときは警告を出して偽として扱う。
 */
export const conditionalBranch = defineCommand({
  code: "ConditionalBranch",
  params,
  meta: {
    label: "条件分岐",
    category: "フロー制御",
    describe: (p, view) => {
      const c = p.condition;
      if (typeof c === "string") return `条件分岐：${c}`;
      return c.kind === "switch" ? `条件分岐：スイッチ ${switchName(view, c.id)} == ${c.value ? "ON" : "OFF"}` : `条件分岐：変数 ${variableName(view, c.id)} ${c.op} ${c.value}`;
    },
    refs: (p): RefTarget[] => {
      const c = p.condition;
      if (typeof c === "string") return [];
      return [{ kind: c.kind, id: c.id }];
    },
  },
  run(p, c): CommandResult {
    const indent = c.interp.commands[c.interp.pc]?.indent ?? 0;
    const { result, warning } = evaluateCondition(p, c);
    return {
      ...(warning ? { effects: [warn(warning)] } : {}),
      setBranch: { [indent]: result ? 0 : 1 },
      control: result ? { kind: "next" } : { kind: "skipBlock", indent },
    };
  },
});

function evaluateCondition(p: Params, c: CommandCtx): { result: boolean; warning?: string } {
  const cond = p.condition;
  if (typeof cond === "string") {
    const r = c.eval(cond);
    if (!r.ok) return { result: false, warning: `ConditionalBranch: 条件式 "${cond}" を評価できない（${r.error.message}）` };
    if (typeof r.value !== "boolean") return { result: false, warning: `ConditionalBranch: 条件式 "${cond}" が真偽値ではない` };
    return { result: r.value };
  }
  if (cond.kind === "switch") {
    const on = Object.hasOwn(c.state.switches, cond.id) && c.state.switches[cond.id] === true;
    return { result: on === cond.value };
  }
  const v = Object.hasOwn(c.state.variables, cond.id) ? (c.state.variables[cond.id] as number) : 0;
  return { result: cond.op === ">=" ? v >= cond.value : cond.op === "<=" ? v <= cond.value : v === cond.value };
}
