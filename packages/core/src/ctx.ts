import type { Ctx } from "./ctx-types.js";
import { registerBuiltins } from "./interpreter/builtins.js";
import { createCommandRegistry } from "./interpreter/registry.js";
import { createFormulaRegistry, registerBuiltinFns } from "./expression/index.js";
import type { ProjectView } from "./project-view.js";

export type { Ctx } from "./ctx-types.js";

/** 組み込みコマンド・組み込み式関数を登録済みの Ctx を作る。 */
export function createCtx(project: ProjectView, overrides: Partial<Pick<Ctx, "commands" | "formulas" | "battleRules">> = {}): Ctx {
  const commands = overrides.commands ?? createCommandRegistry();
  const formulas = overrides.formulas ?? createFormulaRegistry();
  if (overrides.commands === undefined) registerBuiltins(commands);
  if (overrides.formulas === undefined) registerBuiltinFns(formulas);
  return { project, commands, formulas, ...(overrides.battleRules === undefined ? {} : { battleRules: overrides.battleRules }) };
}
