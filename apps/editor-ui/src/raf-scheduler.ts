import type { Scheduler } from "@rpg/runtime";

/** `requestAnimationFrame` の `Scheduler`（player のものと同じ。共有アダプタ化は M7 で検討する）。 */
export function createRafScheduler(): Scheduler {
  return {
    requestFrame(cb) {
      const handle = requestAnimationFrame(cb);
      return () => cancelAnimationFrame(handle);
    },
    now: () => performance.now(),
  };
}
