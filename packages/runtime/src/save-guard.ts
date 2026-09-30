import type { SlotMeta } from "./ports/saves.js";

/** いまのプレイの元になっているセーブデータ：最後にロード/セーブしたスロットと、そのときの進行の指紋。 */
export interface SaveOrigin {
  readonly slot: number;
  readonly fingerprint: string;
}

/**
 * 上書きの確認が要るか：保存先にすでにデータがあり、それが今のプレイの元のスロットではないとき。
 * 空きスロットや、ロード/セーブしたばかりの同じスロットへの保存は確認しない。
 */
export const saveNeedsConfirm = (slots: readonly SlotMeta[], slot: number, origin: SaveOrigin | undefined): boolean =>
  origin?.slot !== slot && slots.some((m) => m.slot === slot);

/**
 * 破棄の確認が要るか：読み込めるデータがあるスロットを選んでいて、今の進行が、最後にセーブ/ロードした状態と違うとき
 * （まだ何もセーブ/ロードしていなければ常に）。セーブした直後・ロードした直後（進行が変わっていない）は確認しない。
 * 空きや読み込めないスロットは、どのみち失敗してゲームは続くので確認しない。
 */
export const loadNeedsConfirm = (slots: readonly SlotMeta[], slot: number, origin: SaveOrigin | undefined, fingerprint: string): boolean =>
  slots.some((m) => m.slot === slot && m.compatible !== "no") && origin?.fingerprint !== fingerprint;
