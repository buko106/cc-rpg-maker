import { ui } from "@rpg/plugin-api";
import type { PluginModule, UiNode } from "@rpg/plugin-api";

/**
 * サンプルプラグイン 1：HUD。マップ画面の左上に所持金を出す。
 * 設定（`system.plugins` の `params`）：`label`（既定 "G"）、`corner`（`"left"` | `"right"`、既定 `"left"`）。
 * 使うのは `projection.after` だけ：FrameSpec を後処理して、UI ノードを足す。
 */
export const hudPlugin: PluginModule = {
  name: "hud",
  version: "1.0.0",
  register(host) {
    const label = typeof host.params["label"] === "string" ? host.params["label"] : "G";
    const right = host.params["corner"] === "right";
    host.projection.after("map", (frame, state) => {
      const w = 76;
      const x = right ? frame.size.width - w - 8 : 8;
      const hud: UiNode = ui.panel(x, 8, w, 28, [ui.text(x + w - 8, 12, `${state.party.gold} ${label}`, { r: 255, g: 255, b: 160, a: 1 }, 14, "right")]);
      // 先頭に足す：メッセージウィンドウなど、ゲーム本来の UI が上に描かれる
      return { ...frame, ui: [hud, ...frame.ui] };
    });
  },
};
