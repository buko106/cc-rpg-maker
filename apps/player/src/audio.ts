import { createDecodeAudio, createWebAudioOut } from "@rpg/audio-webaudio";
import type { WebAudioOut } from "@rpg/audio-webaudio";
import { createNullAudioOut } from "@rpg/audio-null";
import type { AssetSource, AudioOut, Logger } from "@rpg/runtime";

/** 自動再生の制限を解くきっかけになる操作。 */
const UNLOCK_EVENTS = ["keydown", "pointerdown", "touchend"] as const;

/** Web Audio が使えない環境（古いブラウザ・テスト環境）では `undefined`。 */
export function createAudioContext(): AudioContext | undefined {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (Ctor === undefined) return undefined;
  try {
    return new Ctor();
  } catch {
    return undefined;
  }
}

export interface PlayerAudio {
  /** `AssetSource` に渡す音声のデコード関数。`AudioContext` が無ければ `undefined`（音声は読み込まない）。 */
  decodeAudio: ((bytes: ArrayBuffer) => Promise<import("@rpg/runtime").AudioHandle>) | undefined;
  /** アセットが用意できてから、`AudioOut` を作る。 */
  connect(assets: AssetSource, logger: Logger): AudioOut;
}

/**
 * 音の出力。ブラウザの自動再生制限のため、最初のキー/クリック/タッチで `AudioContext` を再開する
 * （それまでの BGM 要求は最後の 1 つだけ覚えておいて、再開後に鳴らす）。
 */
export function createPlayerAudio(ctx: AudioContext | undefined = createAudioContext(), target: EventTarget = window): PlayerAudio {
  return {
    decodeAudio: ctx === undefined ? undefined : createDecodeAudio(ctx),
    connect(assets, logger) {
      if (ctx === undefined) return createNullAudioOut();
      const out: WebAudioOut = createWebAudioOut(ctx, assets, { logger });
      const unlock = (): void => {
        void out.resume().then(() => {
          if (ctx.state === "running") for (const e of UNLOCK_EVENTS) target.removeEventListener(e, unlock);
        });
      };
      for (const e of UNLOCK_EVENTS) target.addEventListener(e, unlock);
      const dispose = out.dispose.bind(out);
      return {
        ...out,
        playBgm: out.playBgm.bind(out),
        stopBgm: out.stopBgm.bind(out),
        playSe: out.playSe.bind(out),
        setMasterVolume: out.setMasterVolume.bind(out),
        dispose() {
          for (const e of UNLOCK_EVENTS) target.removeEventListener(e, unlock);
          dispose();
        },
      };
    },
  };
}
