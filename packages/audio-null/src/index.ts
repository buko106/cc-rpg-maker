/**
 * @rpg/audio-null — Null AudioOut アダプタ。音は鳴らさず、呼び出しを記録する（テスト用）。
 *
 * 設計: docs/08-audio-input.md
 */
import type { AudioOut } from "@rpg/runtime";

export interface AudioCall {
  readonly method: "playBgm" | "stopBgm" | "playSe" | "setMasterVolume" | "dispose";
  readonly args: readonly unknown[];
}

export interface NullAudioOut extends AudioOut {
  /** 呼び出しの記録（古い順）。`dispose` 後の呼び出しは記録されない。 */
  readonly calls: AudioCall[];
  clear(): void;
}

export function createNullAudioOut(): NullAudioOut {
  const calls: AudioCall[] = [];
  let disposed = false;
  const record =
    (method: AudioCall["method"]) =>
    (...args: unknown[]): void => {
      if (!disposed) calls.push({ method, args });
    };
  const dispose = record("dispose");

  return {
    calls,
    playBgm: record("playBgm"),
    stopBgm: record("stopBgm"),
    playSe: record("playSe"),
    setMasterVolume: record("setMasterVolume"),
    dispose() {
      dispose();
      disposed = true;
    },
    clear() {
      calls.length = 0;
    },
  };
}
