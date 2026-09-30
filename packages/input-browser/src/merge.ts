import type { Button, InputFrame, InputSource } from "@rpg/runtime";

/**
 * 複数の入力源（キーボード・ゲームパッド・タッチなど）を 1 つの `InputSource` にまとめる。
 * `pressed` / `triggered` はそれぞれ和集合。`dispose` は全部に伝える。
 * 各入力源の `poll` は、まとめた `poll` のたびに 1 回ずつ呼ぶ（押し始めを取りこぼさない）。
 */
export function mergeInputSources(...sources: readonly InputSource[]): InputSource {
  let disposed = false;
  return {
    poll(): InputFrame {
      const pressed = new Set<Button>();
      const triggered = new Set<Button>();
      for (const source of sources) {
        const frame = source.poll();
        for (const b of frame.pressed) pressed.add(b);
        for (const b of frame.triggered) triggered.add(b);
      }
      return { pressed, triggered };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const source of sources) source.dispose();
    },
  };
}
