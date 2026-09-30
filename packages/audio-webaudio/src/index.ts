/**
 * @rpg/audio-webaudio — Web Audio API の AudioOut アダプタ。
 *
 * 設計: docs/08-audio-input.md
 * - BGM は 1 曲だけ。同じ音源の `playBgm` は再生し直さず、音量/ピッチだけを反映する（多重再生しない）。
 * - `AudioContext` が `suspended`（自動再生制限）の間は、最後の BGM 要求だけを覚えておき、`resume()` /
 *   `running` への変化で再生する。効果音は捨てる（後から鳴らしても意味がない）。例外は投げない。
 * - 音のデコードは `AssetSource`（`createDecodeAudio` を渡す）の側。ここは `AudioBuffer` を受け取って鳴らすだけ。
 */
import type { AssetSource, AudioHandle, AudioOut, AudioRef, Logger } from "@rpg/runtime";
import { noopLogger } from "@rpg/runtime";

export interface WebAudioOut extends AudioOut {
  /** ユーザー操作の中で呼ぶ：`AudioContext` を再開し、待たせていた BGM を鳴らす。 */
  resume(): Promise<void>;
}

export interface WebAudioOptions {
  logger?: Logger;
}

/** `AssetSource` の `decodeAudio` に渡す関数。バイト列を `AudioBuffer` にする。 */
export function createDecodeAudio(ctx: Pick<AudioContext, "decodeAudioData">): (bytes: ArrayBuffer) => Promise<AudioHandle> {
  // decodeAudioData は渡したバッファを消費（detach）するので、キャッシュ側のバイト列を壊さないようコピーを渡す
  return async (bytes) => (await ctx.decodeAudioData(bytes.slice(0))) as unknown as AudioHandle;
}

interface Bgm {
  readonly asset: string;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
const seconds = (ms: number | undefined): number => (ms === undefined || !Number.isFinite(ms) || ms <= 0 ? 0 : ms / 1000);

export function createWebAudioOut(ctx: AudioContext, assets: AssetSource, options: WebAudioOptions = {}): WebAudioOut {
  const logger = options.logger ?? noopLogger;
  const master = ctx.createGain();
  master.connect(ctx.destination);

  let disposed = false;
  let current: Bgm | undefined;
  /** 最新の BGM 要求の通し番号。読み込み中に次の要求が来たら、古い方は捨てる。 */
  let seq = 0;
  /** `suspended` の間に受けた、最後の BGM 要求。 */
  let pending: { ref: AudioRef; fadeMs: number | undefined } | undefined;

  const suspended = (): boolean => ctx.state !== "running";

  const ramp = (gain: GainNode, to: number, fadeSeconds: number): void => {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    if (fadeSeconds <= 0) {
      gain.gain.setValueAtTime(to, now);
      return;
    }
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(to, now + fadeSeconds);
  };

  /** いま鳴っている BGM を（フェードして）止める。 */
  const stopCurrent = (fadeMs: number | undefined): void => {
    const bgm = current;
    current = undefined;
    if (bgm === undefined) return;
    const fade = seconds(fadeMs);
    try {
      ramp(bgm.gain, 0, fade);
      bgm.source.stop(ctx.currentTime + fade);
    } catch {
      /* すでに止まっている */
    }
  };

  const start = async (ref: AudioRef, fadeMs: number | undefined, mySeq: number): Promise<void> => {
    let buffer: AudioBuffer;
    try {
      buffer = (await assets.loadAudio(ref.asset)) as unknown as AudioBuffer;
    } catch (e) {
      logger.warn(`BGM ${ref.asset} を読み込めない: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (disposed || mySeq !== seq) return; // 読み込み中に、次の要求（別の曲・停止）が来た
    try {
      stopCurrent(fadeMs);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = ref.loop;
      source.playbackRate.value = ref.pitch;
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(master);
      const fade = seconds(fadeMs);
      gain.gain.setValueAtTime(fade > 0 ? 0 : clamp01(ref.volume), ctx.currentTime);
      if (fade > 0) gain.gain.linearRampToValueAtTime(clamp01(ref.volume), ctx.currentTime + fade);
      source.start();
      current = { asset: ref.asset, source, gain };
    } catch (e) {
      logger.warn(`BGM を再生できない: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const flush = (): void => {
    if (disposed || pending === undefined || suspended()) return;
    const { ref, fadeMs } = pending;
    pending = undefined;
    void start(ref, fadeMs, ++seq);
  };
  ctx.addEventListener("statechange", flush);

  return {
    playBgm(ref, fadeMs) {
      if (disposed) return;
      try {
        if (current?.asset === ref.asset && !suspended()) {
          // 同じ曲：再生し直さず、音量とピッチだけ反映する
          ramp(current.gain, clamp01(ref.volume), seconds(fadeMs));
          current.source.playbackRate.value = ref.pitch;
          return;
        }
        if (suspended()) {
          seq++; // 読み込み中の古い要求は無効にする
          pending = { ref, fadeMs };
          return;
        }
        pending = undefined;
        void start(ref, fadeMs, ++seq);
      } catch (e) {
        logger.warn(`playBgm に失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    stopBgm(fadeMs) {
      if (disposed) return;
      seq++;
      pending = undefined;
      try {
        stopCurrent(fadeMs);
      } catch (e) {
        logger.warn(`stopBgm に失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    playSe(ref) {
      if (disposed || suspended()) return; // 効果音は後から鳴らしても意味がないので、待たせずに捨てる
      void (async () => {
        try {
          const buffer = (await assets.loadAudio(ref.asset)) as unknown as AudioBuffer;
          if (disposed) return;
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.playbackRate.value = ref.pitch;
          const gain = ctx.createGain();
          gain.gain.value = clamp01(ref.volume);
          source.connect(gain);
          gain.connect(master);
          source.onended = () => {
            source.disconnect();
            gain.disconnect();
          };
          source.start();
        } catch (e) {
          logger.warn(`SE ${ref.asset} を再生できない: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },

    setMasterVolume(v) {
      if (disposed) return;
      master.gain.value = clamp01(v);
    },

    async resume() {
      if (disposed) return;
      try {
        if (ctx.state === "suspended") await ctx.resume();
      } catch (e) {
        logger.warn(`AudioContext を再開できない: ${e instanceof Error ? e.message : String(e)}`);
      }
      flush();
    },

    dispose() {
      if (disposed) return;
      stopCurrent(0);
      disposed = true;
      pending = undefined;
      ctx.removeEventListener("statechange", flush);
      try {
        master.disconnect();
      } catch {
        /* すでに切断されている */
      }
    },
  };
}
