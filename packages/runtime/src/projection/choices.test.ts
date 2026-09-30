import type { GameState } from "@rpg/core";
import { createRuntimeHarness, deepFreeze } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import type { UiNode } from "../frame-spec.js";
import { projectFrame } from "./index.js";

const withMessage = (s: GameState, m: Partial<GameState["message"]>): GameState => ({ ...s, message: { ...s.message, open: true, owner: "i0", ...m } });

const texts = (nodes: readonly UiNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === "text" ? [n.text] : n.kind === "window" ? texts(n.children) : []));
const cursors = (nodes: readonly UiNode[]): Extract<UiNode, { kind: "cursor" }>[] =>
  nodes.flatMap((n) => (n.kind === "cursor" ? [n] : n.kind === "window" ? cursors(n.children) : []));

describe("選択肢・数値入力・タイマーの投影", () => {
  it("選択肢は見出しの下に縦に並び、カーソルは選択中の行に重なる", async () => {
    const h = await createRuntimeHarness({ project: "minimal" });
    const state = deepFreeze(withMessage(h.runtime.getState(), { text: "どうする？", choices: ["戦う", "逃げる", "話す"], cursor: 1 }));
    const frame = projectFrame(state, h.loaded.view);
    expect(texts(frame.ui)).toEqual(["どうする？", "戦う", "逃げる", "話す"]);
    const [cursor] = cursors(frame.ui);
    const rows = frame.ui.flatMap((n) => (n.kind === "window" ? n.children.filter((c) => c.kind === "text") : []));
    // カーソルは 2 番目の選択肢（全体では 3 行目）と同じ行
    expect(cursor!.y).toBeLessThanOrEqual((rows[2] as { y: number }).y);
    expect(cursor!.y + cursor!.h).toBeGreaterThan((rows[2] as { y: number }).y);
  });

  it("見出しが無く、選択肢が画面に入りきらないときは、カーソルが見える範囲だけを出す", async () => {
    const h = await createRuntimeHarness({ project: "minimal" });
    const choices = Array.from({ length: 30 }, (_, i) => `選択肢${i}`);
    const frame = projectFrame(withMessage(h.runtime.getState(), { choices, cursor: 25 }), h.loaded.view);
    const shown = texts(frame.ui);
    expect(shown.length).toBeLessThan(30);
    expect(shown).toContain("選択肢25");
    expect(cursors(frame.ui)).toHaveLength(1);
  });

  it("position が top / middle / bottom で窓の縦位置が変わる", async () => {
    const h = await createRuntimeHarness({ project: "minimal" });
    const ys = (["top", "middle", "bottom"] as const).map((position) => {
      const frame = projectFrame(withMessage(h.runtime.getState(), { choices: ["a"], position }), h.loaded.view);
      return (frame.ui[0] as { y: number }).y;
    });
    expect(ys[0]).toBeLessThan(ys[1]!);
    expect(ys[1]).toBeLessThan(ys[2]!);
  });

  it("数値入力は桁数ぶんの数字（ゼロ埋め）を並べ、編集中の桁にカーソルを置く", async () => {
    const h = await createRuntimeHarness({ project: "minimal" });
    const frame = projectFrame(withMessage(h.runtime.getState(), { numberInput: { digits: 4, value: 42 }, cursor: 3 }), h.loaded.view);
    expect(texts(frame.ui)).toEqual(["0", "0", "4", "2"]);
    const window = frame.ui[0] as Extract<UiNode, { kind: "window" }>;
    const digitNodes = window.children.filter((c): c is Extract<UiNode, { kind: "text" }> => c.kind === "text");
    const [cursor] = cursors(frame.ui);
    expect(cursor!.x).toBeLessThanOrEqual(digitNodes[3]!.x);
    expect(cursor!.x + cursor!.w).toBeGreaterThan(digitNodes[3]!.x);
    // 数値入力の窓は画面の中央に置かれる
    expect(window.x + window.w / 2).toBeCloseTo(h.loaded.project.system.screen.width / 2, 0);
  });

  it("タイマーが動いている間は、右上に残り時間（m:ss）を出す", async () => {
    const h = await createRuntimeHarness({ project: "minimal" });
    const base = h.runtime.getState();
    expect(texts(projectFrame(base, h.loaded.view).ui)).toEqual([]);
    const running = projectFrame({ ...base, timers: { active: true, ticks: 61 } }, h.loaded.view);
    expect(texts(running.ui)).toEqual(["0:02"]);
    const window = running.ui[0] as { x: number; w: number };
    expect(window.x + window.w).toBeLessThanOrEqual(h.loaded.project.system.screen.width);
    expect(texts(projectFrame({ ...base, timers: { active: true, ticks: 60 * 125 } }, h.loaded.view).ui)).toEqual(["2:05"]);
  });
});
