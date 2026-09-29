import { registerBuiltins } from "./interpreter/builtins.js";
import type { CommandRegistry } from "./interpreter/handler.js";
import { createCommandRegistry } from "./interpreter/registry.js";
import { createFormulaRegistry, registerBuiltinFns } from "./expression/index.js";
import type { FormulaRegistry } from "./expression/index.js";
import type { ProjectView } from "./project-view.js";

/** core の関数が受け取る不変の実行コンテキスト。 */
export interface Ctx {
  /** Project + ロード済み MapData の読み取り専用ビュー */
  readonly project: ProjectView;
  readonly commands: CommandRegistry;
  readonly formulas: FormulaRegistry;
}

/** 組み込みコマンド・組み込み式関数を登録済みの Ctx を作る。 */
export function createCtx(project: ProjectView, overrides: Partial<Pick<Ctx, "commands" | "formulas">> = {}): Ctx {
  const commands = overrides.commands ?? createCommandRegistry();
  const formulas = overrides.formulas ?? createFormulaRegistry();
  if (overrides.commands === undefined) registerBuiltins(commands);
  if (overrides.formulas === undefined) registerBuiltinFns(formulas);
  return { project, commands, formulas };
}
