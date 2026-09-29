import { describe, expect, it } from "vitest";
import { missingAssets, rendererContract, sampleFrame } from "@rpg/test-utils";
import { createNullRenderer } from "./index.js";

rendererContract("null", () => createNullRenderer());

describe("createNullRenderer", () => {
  it("render に渡された FrameSpec を記録し、last / clear で扱える", async () => {
    const r = createNullRenderer();
    await r.init({ width: 64, height: 48, assets: missingAssets });
    expect(r.initOpts?.width).toBe(64);
    expect(r.size).toEqual({ width: 64, height: 48 });
    const a = sampleFrame();
    const b = { ...sampleFrame(), camera: { x: 1, y: 2 } };
    r.render(a);
    r.render(b);
    expect(r.frames).toEqual([a, b]);
    expect(r.last()).toBe(b);
    r.resize(10, 20);
    expect(r.size).toEqual({ width: 10, height: 20 });
    r.clear();
    expect(r.frames).toEqual([]);
    expect(r.last()).toBeUndefined();
  });

  it("[inv-3] dispose 後の render / resize / init は何も記録しない", async () => {
    const r = createNullRenderer();
    await r.init({ width: 1, height: 1, assets: missingAssets });
    r.dispose();
    expect(r.disposed).toBe(true);
    r.render(sampleFrame());
    r.resize(5, 5);
    await r.init({ width: 9, height: 9, assets: missingAssets });
    expect(r.frames).toEqual([]);
    expect(r.size).toEqual({ width: 1, height: 1 });
  });
});
