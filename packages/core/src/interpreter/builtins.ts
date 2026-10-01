import type { CommandRegistry } from "./handler.js";
import { changeBgm, fadeoutBgm, playSe } from "./commands/audio.js";
import { battleProcessing } from "./commands/battleProcessing.js";
import { choiceBranch, elseCommand, endBranch } from "./commands/branchEnds.js";
import { inputNumber, selectItem, shopProcessing, showChoices } from "./commands/choices.js";
import { conditionalBranch } from "./commands/conditionalBranch.js";
import { controlSwitches } from "./commands/controlSwitches.js";
import { controlVariables } from "./commands/controlVariables.js";
import { breakLoop, callCommonEvent, comment, endLoop, exitEventProcessing, jumpToLabel, label, loop } from "./commands/flow.js";
import { moveStep, setMoveRoute } from "./commands/moveRoute.js";
import { changeMapTile } from "./commands/changeMapTile.js";
import { setEventLocation } from "./commands/setEventLocation.js";
import { changeExp, changeGold, changeHp, changeItems, changeLevel, changeMp, changeParty, controlSelfSwitch, controlTimer } from "./commands/progress.js";
import { fadein, fadeout, flashScreen, shakeScreen, tintScreen } from "./commands/screen.js";
import { showText } from "./commands/showText.js";
import { gameOver, loadGame, returnToTitle, saveGame, script } from "./commands/system.js";
import { transferPlayer } from "./commands/transferPlayer.js";
import { wait } from "./commands/wait.js";

/**
 * 組み込みコマンドの一覧（docs/03-interpreter.md の表）。
 * M1: ShowText / ControlSwitches / ControlVariables / ConditionalBranch（+ Else / EndBranch）/ Wait / TransferPlayer。
 * M4: BattleProcessing（+ ChoiceBranch）。M6: 残り（フロー・ゲーム進行・メッセージの選択肢・移動ルート・音・画面・システム）。
 */
export const BUILTIN_COMMANDS = [
  // メッセージ
  showText, showChoices, inputNumber, selectItem,
  // ゲーム進行
  controlSwitches, controlVariables, controlSelfSwitch, controlTimer, changeGold, changeItems, changeParty, changeHp, changeMp, changeExp, changeLevel,
  transferPlayer, battleProcessing, shopProcessing,
  // フロー制御
  conditionalBranch, elseCommand, endBranch, choiceBranch, loop, breakLoop, endLoop, exitEventProcessing, callCommonEvent, label, jumpToLabel, wait, comment,
  // 移動
  setMoveRoute, moveStep, setEventLocation, changeMapTile,
  // オーディオ・画面
  changeBgm, playSe, fadeoutBgm, shakeScreen, flashScreen, tintScreen, fadeout, fadein,
  // システム
  saveGame, loadGame, gameOver, returnToTitle, script,
];

/** 組み込みコマンドをすべて登録する。 */
export function registerBuiltins(r: CommandRegistry): void {
  for (const h of BUILTIN_COMMANDS) r.register(h);
}
