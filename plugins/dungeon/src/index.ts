/**
 * @rpg/plugin-dungeon — 不思議のダンジョン（入るたびに地形が変わり、プレイヤーが 1 歩動くと敵も 1 歩動く）。
 *
 * 設計: docs/18-dungeon-plugin.md
 * `@rpg/plugin-api` だけに依存する、第三者のプラグインと同じ立場の実装。ダンジョンの状態は `GameState.pluginState.dungeon` に持ち、
 * 敵・落ちている物は `projection.after` で描く（マップのイベントは使わない）。
 */
import type { PluginModule } from "@rpg/plugin-api";
import { createCommands } from "./commands.js";
import type { ConfigResult } from "./commands.js";
import { parseConfig } from "./config.js";
import { dungeonHud } from "./hud.js";
import { dungeonDiagnostics, dungeonTemplates } from "./templates.js";

export { configSchema, parseConfig } from "./config.js";
export type { Config } from "./config.js";
export { floorTiles, generateFloor, STAIRS, TREASURE, FLOOR, ROCK, walkable } from "./generate.js";
export type { Floor, Pt, Room } from "./generate.js";
export { buildFloor, populateFloor } from "./floor.js";
export { readDungeon } from "./model.js";
export type { DungeonState } from "./model.js";
export { expNeeded } from "./turn.js";

export const dungeonPlugin: PluginModule = {
  name: "dungeon",
  version: "1.0.0",
  register(host) {
    // 設定が不正でも読み込みは成功させる（エディタでは設定なしで読み込まれる）。コマンドが警告を出す。
    const parsed = parseConfig(host.params);
    const config = (): ConfigResult => parsed;
    if (!parsed.ok && Object.keys(host.params).length > 0) host.log.warn(parsed.message);
    for (const c of createCommands(config)) host.commands.add(c);
    host.projection.after("map", (frame, state) => dungeonHud(frame, state, parsed.ok ? parsed.config : undefined));
    for (const t of dungeonTemplates()) host.editor?.eventTemplate(t);
    host.editor?.diagnostics(dungeonDiagnostics);
  },
};
