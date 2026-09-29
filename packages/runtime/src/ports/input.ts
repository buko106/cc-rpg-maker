import type { InputFrame } from "@rpg/core";

/** デバイス入力を抽象ボタンの `InputFrame` に変換するアダプタ（docs/08-audio-input.md）。 */
export interface InputSource {
  /** 呼び出し時点の 1 フレーム分を返し、`triggered` をクリアする。 */
  poll(): InputFrame;
  dispose(): void;
}
