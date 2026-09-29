/**
 * @rpg/input-script — スクリプト InputSource アダプタ。事前に用意した `InputFrame` を順に返す（リプレイ・テスト用）。
 *
 * 設計: docs/08-audio-input.md
 */
import { emptyInput, inputFrame } from "@rpg/runtime";
import type { Button, InputFrame, InputSource } from "@rpg/runtime";

export interface ScriptInput extends InputSource {
  /** フレームを末尾に足す。 */
  push(...frames: InputFrame[]): void;
  /** まだ返していないフレーム数。 */
  remaining(): number;
}

/** 決定論的：同じフレーム列に対して同じ出力。尽きたら空の `InputFrame` を返し続ける。 */
export function createScriptInput(frames: readonly InputFrame[] = []): ScriptInput {
  const queue: InputFrame[] = [...frames];
  let next = 0;
  return {
    poll: () => (next < queue.length ? queue[next++]! : emptyInput()),
    push: (...more) => {
      queue.push(...more);
    },
    remaining: () => queue.length - next,
    dispose() {
      queue.length = next;
    },
  };
}

/** 1 フレームだけ押す（押下開始を含む）。 */
export function keys(...buttons: Button[]): InputFrame {
  return inputFrame(buttons, buttons);
}

/** `button` を `frames` フレーム押し続ける。最初のフレームだけ押下開始。 */
export function hold(button: Button, frames: number): InputFrame[] {
  return Array.from({ length: frames }, (_, i) => inputFrame([button], i === 0 ? [button] : []));
}
