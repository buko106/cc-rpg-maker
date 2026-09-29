import type { Scheduler } from "@rpg/runtime";

/** `requestAnimationFrame` の `Scheduler`。コールバックの時刻は `performance.now()` と同じ時間軸。 */
export function createRafScheduler(): Scheduler {
  return {
    requestFrame(cb) {
      const handle = requestAnimationFrame(cb);
      return () => cancelAnimationFrame(handle);
    },
    now: () => performance.now(),
  };
}
