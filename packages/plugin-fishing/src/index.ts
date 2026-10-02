/**
 * @rpg/plugin-fishing — 釣り大会（竿を振る・あたりを待つ・巻き上げるミニゲーム、図鑑、制限時間つきの大会）。
 *
 * 設計: docs/19-fishing-plugin.md
 * `@rpg/plugin-api` だけに依存する、第三者のプラグインと同じ立場の実装。ミニゲームは「毎フレーム `resume` で入力を読む待機（`wait: plugin`）」で動かし、
 * 状態は `GameState.pluginState.fishing`、表示は `projection.after("map")` で描く。魚・竿・エサはデータベースのアイテム。
 */
import type { PluginModule } from "@rpg/plugin-api";
import { createCommands } from "./commands.js";
import type { ConfigResult } from "./commands.js";
import { parseConfig } from "./config.js";
import { fishingHud } from "./hud.js";
import { fishingDiagnostics, fishingTemplates } from "./templates.js";

export { configSchema, parseConfig } from "./config.js";
export type { Config, FishEntry } from "./config.js";
export { pickFish, pickGear, pointsOf, rank, rollSize, startCast, stepCast } from "./fish.js";
export { readFishing } from "./model.js";
export type { CastState, FishingState } from "./model.js";

export const fishingPlugin: PluginModule = {
  name: "fishing",
  version: "1.0.0",
  register(host) {
    // 設定が不正でも読み込みは成功させる（エディタでは設定なしで読み込まれる）。コマンドが警告を出す。
    const parsed = parseConfig(host.params);
    const config = (): ConfigResult => parsed;
    if (!parsed.ok && Object.keys(host.params).length > 0) host.log.warn(parsed.message);
    for (const c of createCommands(config)) host.commands.add(c);
    host.projection.after("map", (frame, state) => fishingHud(frame, state, parsed.ok ? parsed.config : undefined));
    for (const t of fishingTemplates()) host.editor?.eventTemplate(t);
    host.editor?.diagnostics(fishingDiagnostics);
  },
};
