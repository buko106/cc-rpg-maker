import type { AudioRef } from "@rpg/schema";

/** BGM / SE を鳴らすアダプタ（docs/08-audio-input.md）。`dispose` 後の呼び出しは no-op。 */
export interface AudioOut {
  playBgm(ref: AudioRef, fadeMs?: number): void;
  stopBgm(fadeMs?: number): void;
  playSe(ref: AudioRef): void;
  setMasterVolume(v: number): void;
  dispose(): void;
}
