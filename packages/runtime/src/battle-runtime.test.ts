import { createRuntimeHarness, expandInputs, loadReplay } from "@rpg/test-utils";
import type { FrameSpec, UiNode } from "./index.js";
import { describe, expect, it } from "vitest";

const BATTLE_BGM = "87073bd84cdaced6";
const flatten = (nodes: readonly UiNode[]): UiNode[] => nodes.flatMap((n) => (n.kind === "window" ? [n, ...flatten(n.children)] : [n]));
const textsOf = (f: FrameSpec): string[] => flatten(f.ui).flatMap((n) => (n.kind === "text" ? [n.text] : []));

const boot = (patch?: Parameters<typeof createRuntimeHarness>[0]["patchProject"]) =>
  createRuntimeHarness({ project: "demo", title: true, seed: "battle-win", ...(patch === undefined ? {} : { patchProject: patch }) });

/** 戦闘が始まるところまで（battle-win リプレイの前半：ニューゲーム → スライムに話しかけて戦闘開始）。 */
const toBattle = expandInputs(loadReplay("battle-win").inputs.slice(0, 11));

describe("Runtime × 戦闘", () => {
  it("戦闘が始まると戦闘 BGM を鳴らし、戦闘画面を描く", async () => {
    const h = await boot();
    h.play(...toBattle);
    expect(h.runtime.getState().scene.kind).toBe("battle");
    expect(h.audio.calls.filter((c) => c.method === "playBgm")).toEqual([
      { method: "playBgm", args: [{ asset: BATTLE_BGM, volume: 0.6, pitch: 1, loop: true }, 300] },
    ]);
    const frame = h.renderer.last()!;
    expect(textsOf(frame)).toEqual(expect.arrayContaining(["スライム が あらわれた！", "攻撃", "スキル", "アイテム", "防御", "逃げる", "勇者"]));
    expect(flatten(frame.ui).some((n) => n.kind === "image")).toBe(true); // スライムの絵
  });

  it("勝利して戻ると BGM を止め、マップに戻って続きのイベントが進む", async () => {
    const h = await boot();
    h.play(...expandInputs(loadReplay("battle-win").inputs));
    const state = h.runtime.getState();
    expect(state.scene.kind).toBe("map");
    expect(state.switches).toEqual({ sw_slime_defeated: true });
    expect(h.audio.calls.filter((c) => c.method === "stopBgm")).toHaveLength(2); // ニューゲーム + 戦闘終了
    expect(h.warnings).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("ダメージを受けると画面が揺れる（screenShake）", async () => {
    const h = await boot();
    h.play(...expandInputs(loadReplay("battle-win").inputs.slice(0, 17)));
    h.play(...expandInputs([{ wait: 60 }]));
    expect(h.effects.some((e) => e.kind === "screenShake")).toBe(true);
  });

  it("負けてもよくない戦闘ではゲームオーバー → 決定でタイトルに戻る", async () => {
    const h = await boot((p) => {
      const slime = p.database.enemies["en_slime" as never]!;
      Object.assign(slime.params, { atk: 500, agi: 999 });
      return p;
    });
    h.play(...toBattle);
    // 全員「防御」でも耐えられない
    for (let i = 0; i < 400 && h.runtime.getState().scene.kind === "battle"; i++) {
      const b = h.runtime.getState().battle!;
      if (b.phase === "input") h.play(...expandInputs([{ press: b.inputCursor.menu === "command" && b.inputCursor.index !== 3 ? "down" : "ok" }]));
      else if (b.phase !== "resolve" && b.wait <= 0) h.play(...expandInputs([{ press: "ok" }]));
      else h.advanceFrames(1);
    }
    expect(h.runtime.getState().scene.kind).toBe("gameover");
    expect(textsOf(h.renderer.last()!)).toEqual(["ゲームオーバー"]);
    h.play(...expandInputs([{ press: "ok" }, { wait: 2 }]));
    expect(h.runtime.getState().scene.kind).toBe("title");
    expect(h.audio.calls.filter((c) => c.method === "stopBgm").length).toBeGreaterThanOrEqual(3);
  });
});
