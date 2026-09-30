/**
 * @rpg/plugin-samples — サンプルプラグイン 2 本（`hud`、`custom-command`）。
 *
 * 設計: docs/14-plugin-api.md
 * `@rpg/plugin-api` だけに依存する、第三者のプラグインと同じ立場の実装。プレイヤーとエディタのビルドに同梱される。
 */
export { customCommandPlugin } from "./custom-command.js";
export { hudPlugin } from "./hud.js";

import type { PluginModule } from "@rpg/plugin-api";
import { customCommandPlugin } from "./custom-command.js";
import { hudPlugin } from "./hud.js";

/** ビルドに同梱するプラグインの一覧（プロジェクトの `system.plugins` で有効にしたものが読み込まれる）。 */
export const samplePlugins: readonly PluginModule[] = [hudPlugin, customCommandPlugin];
