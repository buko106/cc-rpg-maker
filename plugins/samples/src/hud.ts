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
      const hud: UiNode = {
        kind: "window",
        x,
        y: 8,
        w,
        h: 28,
        variant: "normal",
        children: [{ kind: "text", x: x + w - 8, y: 12, text: `${state.party.gold} ${label}`, font: { family: "sans-serif", size: 14 }, color: { r: 255, g: 255, b: 160, a: 1 }, align: "right" }],
      };
      // 先頭に足す：メッセージウィンドウなど、ゲーム本来の UI が上に描かれる
      return { ...frame, ui: [hud, ...frame.ui] };
    });
  },
};
