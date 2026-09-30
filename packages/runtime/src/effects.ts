import type { Effect } from "@rpg/core";
import type { MapId } from "@rpg/schema";
import type { AudioOut } from "./ports/audio.js";
import type { Logger } from "./ports/logger.js";

/** `Effect` の届け先。 */
export interface EffectSinks {
  audio: AudioOut;
  logger: Logger;
  /** シェイク・フラッシュ（見た目だけの一時状態）。 */
  visual(effect: Extract<Effect, { kind: "screenShake" | "screenFlash" }>): void;
  /** マップの遅延ロードを始める。 */
  loadMap(mapId: MapId): void;
  /** 現在の状態を `slot` に保存する。`slot` 省略時は最初のスロット。 */
  save(slot: number | undefined): void;
  /** `slot` のセーブデータを読み込んで再開する。`slot` 省略時は最初のスロット。 */
  load(slot: number | undefined): void;
}

/**
 * `Effect` を届け先へ分配する。すべての Effect は必ずどれかに届く（不変条件 5）：
 * 未対応のもの（プラグイン・未知の種類）は logger.warn に流す。
 */
export function distributeEffect(effect: Effect, sinks: EffectSinks): void {
  switch (effect.kind) {
    case "playSe":
      sinks.audio.playSe(effect.audio);
      return;
    case "playBgm":
      sinks.audio.playBgm(effect.audio, effect.fadeMs);
      return;
    case "stopBgm":
      sinks.audio.stopBgm(effect.fadeMs);
      return;
    case "screenShake":
    case "screenFlash":
      sinks.visual(effect);
      return;
    case "requestMapData":
      sinks.loadMap(effect.mapId);
      return;
    case "requestSave":
      sinks.save(effect.slot);
      return;
    case "requestLoad":
      sinks.load(effect.slot);
      return;
    case "log":
      sinks.logger[effect.level](effect.message);
      return;
    case "plugin":
      sinks.logger.warn(`plugin effect ${effect.name}: プラグインは未対応`);
      return;
    default: {
      const unknown: { kind?: unknown } = effect;
      sinks.logger.warn(`未処理の Effect: ${String(unknown.kind)}`);
    }
  }
}
