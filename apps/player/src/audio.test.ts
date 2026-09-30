import type { AssetSource } from "@rpg/runtime";
import { describe, expect, it } from "vitest";
import { createAudioContext, createPlayerAudio } from "./audio.js";

const assets: AssetSource = {
  loadImage: () => Promise.reject(new Error("x")),
  loadAudio: () => Promise.resolve({} as never),
  loadJson: () => Promise.reject(new Error("x")),
  has: () => Promise.resolve(true),
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** resume() で running になる最小の AudioContext。 */
function fakeContext(initial: "suspended" | "running" = "suspended") {
  const target = new EventTarget();
  const ctx = {
    state: initial,
    currentTime: 0,
    destination: {},
    resumed: 0,
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    decodeAudioData: () => Promise.resolve({}),
    resume() {
      ctx.resumed++;
      ctx.state = "running";
      return Promise.resolve();
    },
  };
  return ctx;
}

describe("createPlayerAudio", () => {
  it("AudioContext が無い環境では音声をデコードせず、何もしない AudioOut を返す", () => {
    const audio = createPlayerAudio(undefined, new EventTarget());
    expect(audio.decodeAudio).toBeUndefined();
    const out = audio.connect(assets, logger);
    expect(() => {
      out.playBgm({ asset: "aaaaaaaaaaaaaaaa" as never, volume: 1, pitch: 1, loop: true });
      out.stopBgm();
      out.dispose();
    }).not.toThrow();
  });

  it("最初のキー操作で AudioContext を再開し、再開できたらリスナーを外す", async () => {
    const ctx = fakeContext();
    const target = new EventTarget();
    const audio = createPlayerAudio(ctx as never, target);
    expect(audio.decodeAudio).toBeDefined();
    audio.connect(assets, logger);
    expect(ctx.resumed).toBe(0);
    target.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.resumed).toBe(1);
    expect(ctx.state).toBe("running");
    target.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(ctx.resumed).toBe(1); // もう外れている
  });

  it("dispose でリスナーを外す（以後の操作で再開しない）", async () => {
    const ctx = fakeContext();
    const target = new EventTarget();
    const out = createPlayerAudio(ctx as never, target).connect(assets, logger);
    out.dispose();
    target.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    expect(ctx.resumed).toBe(0);
  });
});

describe("createAudioContext", () => {
  it("Web Audio が無い環境（Node）では undefined", () => {
    expect(createAudioContext()).toBeUndefined();
  });
});
