import { afterEach, describe, expect, it, vi } from "vitest";
import { createRafScheduler } from "./raf-scheduler.js";

afterEach(() => vi.unstubAllGlobals());

describe("createRafScheduler", () => {
  it("requestAnimationFrame に委譲し、cancel で取り消せる。now は performance.now", () => {
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      cb(123);
      return 7;
    });
    vi.stubGlobal("cancelAnimationFrame", (h: number) => cancelled.push(h));
    vi.stubGlobal("performance", { now: () => 42 });

    const s = createRafScheduler();
    const seen: number[] = [];
    const cancel = s.requestFrame((t) => seen.push(t));
    expect(seen).toEqual([123]);
    cancel();
    expect(cancelled).toEqual([7]);
    expect(s.now()).toBe(42);
  });
});
