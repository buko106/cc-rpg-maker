import { describe, expect, it } from "vitest";
import { ui } from "./index.js";

const white = { r: 255, g: 255, b: 255, a: 1 };

describe("ui（UiNode の組み立て部品）", () => {
  it("text: 既定は左寄せ・13px・太字なし（bold は項目ごと省く）", () => {
    expect(ui.text(1, 2, "HP", white)).toEqual({ kind: "text", x: 1, y: 2, text: "HP", font: { family: "sans-serif", size: 13 }, color: white, align: "left" });
    const t = ui.text(0, 0, "A", white, 20, "center", true);
    expect(t).toMatchObject({ align: "center", font: { size: 20, bold: true } });
    expect("bold" in ui.font(12)).toBe(false);
  });

  it("gauge は座標をそのまま、rect は整数に丸めた ratio 1 のゲージ", () => {
    expect(ui.gauge(1.5, 2, 30, 4, 0.25, white)).toEqual({ kind: "gauge", x: 1.5, y: 2, w: 30, h: 4, ratio: 0.25, color: white });
    expect(ui.rect(1.4, 2.6, 9.5, 3.2, white)).toEqual({ kind: "gauge", x: 1, y: 3, w: 10, h: 3, ratio: 1, color: white });
  });

  it("panel: 既定は normal、子をそのまま持つ", () => {
    const child = ui.text(0, 0, "x", white);
    expect(ui.panel(8, 8, 100, 40, [child])).toEqual({ kind: "window", x: 8, y: 8, w: 100, h: 40, variant: "normal", children: [child] });
    expect(ui.panel(0, 0, 1, 1, [], "dim")).toMatchObject({ variant: "dim" });
  });
});
