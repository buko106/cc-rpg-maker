import type { BattleRules } from "./battle/rules.js";
import type { FormulaRegistry } from "./expression/registry.js";
import type { CommandRegistry } from "./interpreter/handler.js";
import type { ProjectView } from "./project-view.js";

/**
 * core の関数が受け取る不変の実行コンテキスト。
 * 型だけをここに分けてあるのは、`createCtx`（`ctx.ts`）が組み込みコマンドを import し、そのコマンドが戦闘などを
 * import するので、それらが `Ctx` の型を `ctx.ts` から import すると循環になるため。
 */
export interface Ctx {
  /** Project + ロード済み MapData の読み取り専用ビュー */
  readonly project: ProjectView;
  readonly commands: CommandRegistry;
  readonly formulas: FormulaRegistry;
  /** 戦闘の命中・会心・行動順・逃走の計算。省略時は `defaultBattleRules`。プラグインで差し替える。 */
  readonly battleRules?: BattleRules;
}
