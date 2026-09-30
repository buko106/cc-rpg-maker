import type { Button } from "@rpg/runtime";

/**
 * 「今押されているボタン」と「前回の `take` 以降に押され始めたボタン」を覚えておく小さな状態。
 * キーボードとタッチが共有する。押してすぐ離したボタンも、次の `take` では `pressed` に含める（`triggered ⊆ pressed`）。
 */
export interface ButtonLatch {
  down(button: Button): void;
  up(button: Button): void;
  /** すべて離す（フォーカスを失ったときなど）。押し始めの記録は残す。 */
  releaseAll(): void;
  /** 現在の状態を取り出し、押し始めの記録をクリアする。 */
  take(): { pressed: Set<Button>; triggered: Set<Button> };
  /** 押しっぱなしも押し始めの記録も捨てる。 */
  reset(): void;
}

export function createButtonLatch(): ButtonLatch {
  const held = new Set<Button>();
  const started = new Set<Button>();
  return {
    down(button) {
      if (!held.has(button)) started.add(button);
      held.add(button);
    },
    up(button) {
      held.delete(button);
    },
    releaseAll() {
      held.clear();
    },
    take() {
      const triggered = new Set(started);
      started.clear();
      return { pressed: new Set([...held, ...triggered]), triggered };
    },
    reset() {
      held.clear();
      started.clear();
    },
  };
}
