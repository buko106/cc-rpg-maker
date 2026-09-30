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
  /** 画面の色調を `durationTicks` かけて変える（`a` = 0 で元に戻る）。見た目だけの状態で、セーブされない。 */
  | { readonly kind: "screenTint"; readonly color: RGBA; readonly durationTicks: number }
  /** 画面を `durationTicks` かけて暗転（`to` = 1）/明転（`to` = 0）する。暗転は明転を指示するまで続く。 */
  | { readonly kind: "screenFade"; readonly to: 0 | 1; readonly durationTicks: number }
  /** `confirmed` は確認ダイアログで「はい」を選んだ後の要求（runtime は再確認しない）。 */
  | { readonly kind: "requestSave"; readonly slot?: number; readonly confirmed?: boolean }
  | { readonly kind: "requestLoad"; readonly slot?: number; readonly confirmed?: boolean }
  /** 遅延ロード。runtime が Ctx に供給してから再開する。 */
  | { readonly kind: "requestMapData"; readonly mapId: MapId }
  | { readonly kind: "log"; readonly level: "debug" | "info" | "warn"; readonly message: string }
  | { readonly kind: "plugin"; readonly name: string; readonly payload: unknown };

export const warn = (message: string): Effect => ({ kind: "log", level: "warn", message });
