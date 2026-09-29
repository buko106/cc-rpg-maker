import type { AudioRef, MapId } from "@rpg/schema";

export interface RGBA {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * core → 外界への要求。純データ。
 * 発行した瞬間に状態から消える（状態に副作用キューを持たない）。`runtime` は返された `effects` を同フレーム内で処理する。
 */
export type Effect =
  | { readonly kind: "playSe"; readonly audio: AudioRef }
  | { readonly kind: "playBgm"; readonly audio: AudioRef; readonly fadeMs?: number }
  | { readonly kind: "stopBgm"; readonly fadeMs?: number }
  | { readonly kind: "screenShake"; readonly power: number; readonly durationTicks: number }
  | { readonly kind: "screenFlash"; readonly color: RGBA; readonly durationTicks: number }
  | { readonly kind: "requestSave"; readonly slot?: number }
  | { readonly kind: "requestLoad"; readonly slot?: number }
  /** 遅延ロード。runtime が Ctx に供給してから再開する。 */
  | { readonly kind: "requestMapData"; readonly mapId: MapId }
  | { readonly kind: "log"; readonly level: "debug" | "info" | "warn"; readonly message: string }
  | { readonly kind: "plugin"; readonly name: string; readonly payload: unknown };

export const warn = (message: string): Effect => ({ kind: "log", level: "warn", message });
