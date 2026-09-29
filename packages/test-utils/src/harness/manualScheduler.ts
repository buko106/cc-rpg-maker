import type { Scheduler } from "@rpg/runtime";

/** 60fps 相当のフレーム間隔（ms）。 */
export const DEFAULT_FRAME_MS = 1000 / 60;

/** 浮動小数点誤差の許容（ms）。`advance(16.67 * 3)` を 3 フレームとして数えるために使う。 */
const EPSILON_MS = 0.05;

export interface ManualSchedulerOptions {
  /** 1 フレームの長さ（ms）。既定は 1000/60。 */
  frameMs?: number;
  /** 仮想時計の初期値（ms）。既定は 0。 */
  startMs?: number;
}

export interface ManualScheduler extends Scheduler {
  /**
   * 仮想時計を `ms` 進める。経過したフレーム境界ごとに、その時点で登録済みのコールバックを一度ずつ呼ぶ。
   * コールバック内で登録した `requestFrame` は次のフレーム境界まで呼ばれない（requestAnimationFrame と同じ）。
   * `ms` が負または非有限なら RangeError（プログラミングエラー）。
   */
  advance(ms: number): void;
  /** 登録済みで未実行のコールバック数。 */
  readonly pendingCount: number;
}

/**
 * 手動で時間を進める Scheduler。実時間・タイマーに依存しないため決定論的。
 *
 * 不変条件:
 * - フレーム境界は `startMs + k * frameMs`（k = 1, 2, …）。`advance` の分割の仕方に依存しない。
 * - コールバックには、そのフレーム境界の時刻が渡される。
 */
export function createManualScheduler(options: ManualSchedulerOptions = {}): ManualScheduler {
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
  const startMs = options.startMs ?? 0;
  if (!(frameMs > 0) || !Number.isFinite(frameMs)) {
    throw new RangeError(`frameMs must be a positive finite number: ${frameMs}`);
  }

  let elapsedEnd = startMs; // advance の累計（分割方法に依存しない厳密な合計）
  let current = startMs; // now() が返す時刻。コールバック実行中はフレーム境界の時刻
  let frameIndex = 0; // 実行済みフレーム境界の数
  const pending = new Map<number, (nowMs: number) => void>();
  let nextHandle = 0;

  return {
    now: () => current,

    requestFrame(cb) {
      const handle = nextHandle++;
      pending.set(handle, cb);
      return () => {
        pending.delete(handle);
      };
    },

    get pendingCount() {
      return pending.size;
    },

    advance(ms) {
      if (!(ms >= 0) || !Number.isFinite(ms)) {
        throw new RangeError(`advance(ms) requires a non-negative finite number: ${ms}`);
      }
      elapsedEnd += ms;
      for (;;) {
        const boundary = startMs + (frameIndex + 1) * frameMs;
        if (boundary > elapsedEnd + EPSILON_MS) break;
        frameIndex++;
        current = Math.max(current, boundary);
        // このフレームの開始時点で登録済みのものだけを実行する。実行中に登録されたものは次フレーム。
        for (const [handle, cb] of [...pending]) {
          if (!pending.has(handle)) continue; // 先に実行されたコールバックがキャンセルした
          pending.delete(handle);
          cb(boundary);
        }
      }
      current = Math.max(current, elapsedEnd);
    },
  };
}
