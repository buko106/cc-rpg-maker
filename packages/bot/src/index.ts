/**
 * @rpg/bot：ゲームを自動で遊ぶ bot（docs/20-bot.md）。難易度の調整に使う。
 * 戦闘を人と同じ入力（十字キーと決定）で戦い、何回も試して勝率・ターン数・HP の残りをまとめる。
 * core だけに依存し、ブラウザでも Node でも動く。
 */
export { battleBotInput, runBattle } from "./driver.js";
export type { BattleChoice, BattlePolicy, BattleRun, BattleTurn } from "./driver.js";
export { attackPolicy, guardPolicy, healsHp, POLICIES, smartPolicy } from "./policies.js";
export type { SmartPolicyOptions } from "./policies.js";
export { formatLevelTable, levelSweep, lowestLevel, prepareParty, simulateBattles } from "./simulate.js";
export type { BattleReport, LevelRow, PartySetup, SimulationOptions } from "./simulate.js";
