import { describe, expect, it } from "vitest";
import { applyFxEffect, NO_FX } from "../visual-fx.js";
import { projectPictures } from "./picture.js";

const asset = (c: string) => c.repeat(16) as never;
const show = (fx: ReturnType<typeof applyFxEffect>, id: number, over: object = {}) =>
  applyFxEffect(fx, { kind: "showPicture", id, asset: asset(String(id)), x: id * 10, y: 5, origin: "topLeft", opacity: 1, scale: 1, durationTicks: 0, ...over });

describe("projectPictures", () => {
  it("ピクチャが無ければ空", () => {
    expect(projectPictures(NO_FX)).toEqual([]);
  });

  it("番号の小さい順（大きいほど手前）に image ノードにする。center は origin を渡し、座標は丸める", () => {
    const fx = show(show(NO_FX, 2, { origin: "center", opacity: 0.5, scale: 2, x: 10.4 }), 1);
    expect(projectPictures(fx)).toEqual([
      { kind: "image", asset: asset("1"), x: 10, y: 5, alpha: 1, scale: 1 },
      { kind: "image", asset: asset("2"), x: 10, y: 5, alpha: 0.5, scale: 2, origin: "center" },
    ]);
  });
});
