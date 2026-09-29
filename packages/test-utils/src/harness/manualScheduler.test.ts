import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createManualScheduler, DEFAULT_FRAME_MS } from "./manualScheduler.js";

/** 毎フレーム自分を再登録するループ。ゲームループの代役。 */
function runLoop(scheduler: ReturnType<typeof createManualScheduler>): number[] {
  const frames: number[] = [];
  const loop = (nowMs: number): void => {
    frames.push(nowMs);
    scheduler.requestFrame(loop);
  };
  scheduler.requestFrame(loop);
  return frames;
}

describe("manualScheduler", () => {
  it("does not run callbacks until time advances", () => {
    const s = createManualScheduler();
    const frames = runLoop(s);
    expect(frames).toEqual([]);
    expect(s.now()).toBe(0);
  });

  it("advance(16.67 * 3) drives exactly 3 frames", () => {
    const s = createManualScheduler();
    const frames = runLoop(s);
    s.advance(16.67 * 3);
    expect(frames).toHaveLength(3);
  });

  it("passes the frame boundary time to callbacks", () => {
    const s = createManualScheduler({ frameMs: 10, startMs: 100 });
    const frames = runLoop(s);
    s.advance(35);
    expect(frames).toEqual([110, 120, 130]);
    expect(s.now()).toBe(135);
  });

  it("runs a callback registered during a frame on the next frame, not the same one", () => {
    const s = createManualScheduler({ frameMs: 10 });
    const frames = runLoop(s);
    s.advance(10);
    expect(frames).toHaveLength(1);
    expect(s.pendingCount).toBe(1);
  });

  it("does not run a cancelled callback", () => {
    const s = createManualScheduler({ frameMs: 10 });
    let called = 0;
    const cancel = s.requestFrame(() => called++);
    cancel();
    s.advance(100);
    expect(called).toBe(0);
    expect(s.pendingCount).toBe(0);
  });

  it("does not run a callback cancelled by an earlier callback in the same frame", () => {
    const s = createManualScheduler({ frameMs: 10 });
    const calls: string[] = [];
    let cancelB = (): void => {};
    s.requestFrame(() => {
      calls.push("a");
      cancelB();
    });
    cancelB = s.requestFrame(() => calls.push("b"));
    s.advance(10);
    expect(calls).toEqual(["a"]);
  });

  it("keeps the clock moving even when nothing is scheduled", () => {
    const s = createManualScheduler();
    s.advance(1234);
    expect(s.now()).toBe(1234);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects advance(%s)", (ms) => {
    expect(() => createManualScheduler().advance(ms)).toThrow(RangeError);
  });

  it.each([0, -5, Number.NaN])("rejects frameMs = %s", (frameMs) => {
    expect(() => createManualScheduler({ frameMs })).toThrow(RangeError);
  });

  it("[property] frame times do not depend on how advance() is split", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 200 }), { maxLength: 40 }), (chunks) => {
        const total = chunks.reduce((a, b) => a + b, 0);

        const whole = createManualScheduler();
        const wholeFrames = runLoop(whole);
        whole.advance(total);

        const split = createManualScheduler();
        const splitFrames = runLoop(split);
        for (const chunk of chunks) split.advance(chunk);

        expect(splitFrames).toEqual(wholeFrames);
        expect(split.now()).toBe(whole.now());
      }),
    );
  });

  it("[property] frame count is floor(total / frameMs) up to rounding tolerance", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (total) => {
        const s = createManualScheduler();
        const frames = runLoop(s);
        s.advance(total);
        expect(Math.abs(frames.length - total / DEFAULT_FRAME_MS)).toBeLessThan(1 + 1e-9);
      }),
    );
  });
});
