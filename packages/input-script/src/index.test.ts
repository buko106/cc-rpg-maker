import { describe, expect, it } from "vitest";
import { inputSourceContract } from "@rpg/test-utils";
import { createScriptInput, hold, keys } from "./index.js";

inputSourceContract("script", () => {
  const source = createScriptInput();
  return { source, press: (b) => source.push(keys(b)), release: () => {} };
});

describe("createScriptInput", () => {
  it("push した順に 1 フレームずつ返し、尽きたら空のフレームを返し続ける", () => {
    const s = createScriptInput([keys("ok")]);
    s.push(...hold("right", 2));
    expect(s.remaining()).toBe(3);
    expect([...s.poll().triggered]).toEqual(["ok"]);
    const h1 = s.poll();
    const h2 = s.poll();
    expect([...h1.pressed, ...h1.triggered]).toEqual(["right", "right"]);
    expect([...h2.pressed]).toEqual(["right"]);
    expect(h2.triggered.size).toBe(0);
    expect(s.remaining()).toBe(0);
    for (let i = 0; i < 3; i++) expect(s.poll()).toEqual({ pressed: new Set(), triggered: new Set() });
  });

  it("[inv-3] 同じフレーム列から同じ出力が得られる", () => {
    const frames = [...hold("down", 3), keys("ok", "cancel")];
    const run = (): unknown[] => {
      const s = createScriptInput(frames);
      return frames.map(() => {
        const f = s.poll();
        return [[...f.pressed], [...f.triggered]];
      });
    };
    expect(run()).toEqual(run());
  });

  it("keys / hold は triggered ⊆ pressed のフレームを作る", () => {
    expect(keys("up", "ok")).toEqual({ pressed: new Set(["up", "ok"]), triggered: new Set(["up", "ok"]) });
    const h = hold("left", 3);
    expect(h).toHaveLength(3);
    expect(h.map((f) => f.triggered.size)).toEqual([1, 0, 0]);
    expect(h.every((f) => f.pressed.has("left"))).toBe(true);
    expect(hold("left", 0)).toEqual([]);
  });

  it("dispose すると残りのフレームを捨てる", () => {
    const s = createScriptInput(hold("up", 5));
    s.poll();
    s.dispose();
    expect(s.remaining()).toBe(0);
  });
});
