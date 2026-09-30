import { variableIdSchema } from "@rpg/schema";
import type { RefTarget } from "@rpg/schema";
import { z } from "zod";
import { warn } from "../../effects.js";
import { defineCommand } from "../handler.js";
import type { ProjectView } from "../../project-view.js";
import { variableIds, variableName } from "./params.js";

const operand = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("constant"), value: z.number() }),
  z.strictObject({ kind: z.literal("variable"), id: variableIdSchema }),
  z.strictObject({ kind: z.literal("random"), min: z.number().int(), max: z.number().int() }),
  z.strictObject({ kind: z.literal("expr"), expr: z.string() }),
]);

const params = z.strictObject({
  ids: variableIds,
  op: z.enum(["set", "add", "sub", "mul", "div", "mod"]).meta({ labels: { set: "代入（＝）", add: "加算（＋）", sub: "減算（－）", mul: "乗算（×）", div: "除算（÷）", mod: "剰余（％）" } }),
  operand,
});

/**
 * 変数の操作。`div` は切り捨て除算（RPGツクール MV 互換）。
 * `div` / `mod` の除数が 0 のとき、変数は変わらない。
 */
export const controlVariables = defineCommand({
  code: "ControlVariables",
  params,
  meta: {
    label: "変数の操作",
    category: "ゲーム進行",
    describe: (p, view) => `変数 ${p.ids.map((id) => variableName(view, id)).join(", ")} ${OP_LABEL[p.op]} ${describeOperand(p.operand, view)}`,
    refs: (p) => {
      const refs: RefTarget[] = p.ids.map((id) => ({ kind: "variable", id }));
      if (p.operand.kind === "variable") refs.push({ kind: "variable", id: p.operand.id });
      return refs;
    },
  },
  run(p, c) {
    const read = (id: string): number => (Object.hasOwn(c.state.variables, id) ? (c.state.variables[id as never] as number) : 0);

    let value: number;
    switch (p.operand.kind) {
      case "constant":
        value = p.operand.value;
        break;
      case "variable":
        value = read(p.operand.id);
        break;
      case "random": {
        const lo = Math.min(p.operand.min, p.operand.max);
        const hi = Math.max(p.operand.min, p.operand.max);
        value = c.rng.int(lo, hi);
        break;
      }
      case "expr": {
        const r = c.eval(p.operand.expr);
        if (!r.ok || typeof r.value !== "number") {
          const why = r.ok ? `数値ではない結果: ${typeof r.value}` : r.error.message;
          return { effects: [warn(`ControlVariables: 式 "${p.operand.expr}" を評価できない（${why}）`)] };
        }
        value = r.value;
        break;
      }
    }

    const variables = { ...c.state.variables };
    for (const id of p.ids) {
      const current = read(id);
      const next = apply(p.op, current, value);
      if (next !== undefined) variables[id] = next;
    }
    return { state: { ...c.state, variables } };
  },
});

function apply(op: z.output<typeof params>["op"], current: number, operand: number): number | undefined {
  switch (op) {
    case "set": return operand;
    case "add": return current + operand;
    case "sub": return current - operand;
    case "mul": return current * operand;
    case "div": return operand === 0 ? undefined : Math.floor(current / operand);
    case "mod": return operand === 0 ? undefined : current % operand;
  }
}

const OP_LABEL = { set: "＝", add: "＋", sub: "－", mul: "×", div: "÷", mod: "％" } as const;

function describeOperand(o: z.output<typeof params>["operand"], view: ProjectView): string {
  switch (o.kind) {
    case "constant": return String(o.value);
    case "variable": return `変数 ${variableName(view, o.id)}`;
    case "random": return `乱数 ${o.min}〜${o.max}`;
    case "expr": return `式 ${o.expr}`;
  }
}
