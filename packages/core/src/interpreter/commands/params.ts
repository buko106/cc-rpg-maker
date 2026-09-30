import { switchIdSchema, variableIdSchema } from "@rpg/schema";
import type { VariableId } from "@rpg/schema";
import { z } from "zod";
import type { ProjectView } from "../../project-view.js";

/** 複数のコマンドで共通の params 部品。 */
export const switchIds = z.array(switchIdSchema).min(1);
export const variableIds = z.array(variableIdSchema).min(1);
export const comparison = z.enum([">=", "==", "<="]);

/** 増減の量：定数か、変数の値。 */
export const amount = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("constant"), value: z.number().int() }),
  z.strictObject({ kind: z.literal("variable"), id: variableIdSchema }),
]);
export type Amount = z.output<typeof amount>;

/** `Amount` を現在の変数から数値にする。 */
export const readAmount = (a: Amount, variables: Readonly<Record<string, number>>): number =>
  a.kind === "constant" ? a.value : Object.hasOwn(variables, a.id) ? (variables[a.id] as number) : 0;

export const amountRefs = (a: Amount): { kind: "variable"; id: VariableId }[] => (a.kind === "variable" ? [{ kind: "variable", id: a.id }] : []);

/** 1 行表示に出すスイッチ・変数の呼び名：名前があれば名前、無ければ ID。 */
export const switchName = (view: ProjectView, id: string): string => nameIn(view.project.switches, id);
export const variableName = (view: ProjectView, id: string): string => nameIn(view.project.variables, id);
const nameIn = (table: Readonly<Record<string, { name: string }>>, id: string): string => (Object.hasOwn(table, id) && table[id]!.name !== "" ? table[id]!.name : id);

export const describeAmount = (a: Amount): string => (a.kind === "constant" ? String(a.value) : `変数 ${a.id}`);
