import type { CommandRegistry } from "./handler.js";
import { elseCommand, endBranch } from "./commands/branchEnds.js";
import { conditionalBranch } from "./commands/conditionalBranch.js";
import { controlSwitches } from "./commands/controlSwitches.js";
import { controlVariables } from "./commands/controlVariables.js";
import { showText } from "./commands/showText.js";
import { transferPlayer } from "./commands/transferPlayer.js";
import { wait } from "./commands/wait.js";

/**
 * 組み込みコマンドを登録する。
 * M1 の範囲: ShowText / ControlSwitches / ControlVariables / ConditionalBranch（+ Else / EndBranch）/ Wait / TransferPlayer。
 * 残りは M6（docs/17-milestones.md）。
 */
export function registerBuiltins(r: CommandRegistry): void {
  for (const h of [showText, controlSwitches, controlVariables, conditionalBranch, elseCommand, endBranch, wait, transferPlayer]) {
    r.register(h);
  }
}
