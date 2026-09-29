import { describe, expect, it } from "vitest";
import type { Button, InputSource } from "@rpg/runtime";
import type { ContractFactory } from "./contract.js";

/**
 * 契約テストがデバイス入力を再現するための操作口。
 * アダプタごとに実装する（browser ならキーイベントを dispatch、script ならフレームを積む）。
 */
export interface InputDriver {
  source: InputSource;
  /** ボタンを押す（押しっぱなしにする）。 */
  press(button: Button): void;
  /** ボタンを離す。 */
  release(button: Button): void;
}

/** InputSource の契約スイート（docs/08-audio-input.md の不変条件 1, 2）。 */
export function inputSourceContract(name: string, make: ContractFactory<InputDriver>): void {
  describe(`InputSource contract: ${name}`, () => {
    it("何も押していなければ空のフレーム", async () => {
      const { source } = await make();
      const f = source.poll();
      expect(f.pressed.size).toBe(0);
      expect(f.triggered.size).toBe(0);
    });

    it("[inv-1] 押したボタンは pressed と triggered の両方に入り、triggered ⊆ pressed が常に成り立つ", async () => {
      const d = await make();
      d.press("ok");
      const first = d.source.poll();
      expect(first.pressed.has("ok")).toBe(true);
      expect(first.triggered.has("ok")).toBe(true);
      for (const b of first.triggered) expect(first.pressed.has(b)).toBe(true);

      d.press("left");
      d.release("ok");
      for (let i = 0; i < 3; i++) {
        const f = d.source.poll();
        for (const b of f.triggered) expect(f.pressed.has(b)).toBe(true);
      }
    });

    it("[inv-2] poll を 2 回続けて呼ぶと、2 回目の triggered は空", async () => {
      const d = await make();
      d.press("cancel");
      const first = d.source.poll();
      expect(first.triggered.size).toBeGreaterThan(0);
      expect(d.source.poll().triggered.size).toBe(0);
    });

    it("dispose 後の poll は例外を出さない", async () => {
      const d = await make();
      d.source.dispose();
      expect(() => d.source.poll()).not.toThrow();
    });
  });
}
