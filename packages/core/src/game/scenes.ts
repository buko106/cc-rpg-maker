import type { ProjectView } from "../project-view.js";
import type { GameState } from "../state.js";

/** タイトルのコマンド（順序が `scene.cursor` の意味）。表示文言は runtime が `system.terms[key]` から引く。 */
export const TITLE_ITEMS = ["newGame", "continue"] as const;
/** メニューのコマンド。 */
export const MENU_ITEMS = ["item", "status", "save", "load"] as const;

/** セーブ/ロード画面に並べるスロット番号は `SAVE_SLOT_FIRST` から `SAVE_SLOT_COUNT` 個（スロット 0 はオートセーブ用で別扱い）。 */
export const SAVE_SLOT_FIRST = 1;
export const SAVE_SLOT_COUNT = 10;
/** オートセーブ専用のスロット。セーブ画面には並ばず（手動では書けない）、有効なプロジェクトではロード画面/コンティニューの先頭に並ぶ。 */
export const AUTOSAVE_SLOT = 0;

/** このプロジェクトでオートセーブが有効か（`system.autosave`。いまは場所移動のときだけ）。 */
export const autosaveOnTransfer = (project: ProjectView): boolean => project.project.system.autosave?.onTransfer === true;

/** セーブ画面に並ぶスロット番号（手動セーブ用）。カーソルの位置 → スロット番号の対応。 */
export const saveSlotNumbers = (): number[] => Array.from({ length: SAVE_SLOT_COUNT }, (_, i) => SAVE_SLOT_FIRST + i);

/** ロード画面・コンティニューに並ぶスロット番号。オートセーブが有効なら先頭にスロット 0 が付く。 */
export const loadSlotNumbers = (project: ProjectView): number[] => (autosaveOnTransfer(project) ? [AUTOSAVE_SLOT, ...saveSlotNumbers()] : saveSlotNumbers());

/** メニューのアイテム画面に並ぶアイテム ID（所持数 1 以上、ID 順）。 */
export function menuItemIds(state: GameState): string[] {
  return Object.entries(state.party.items)
    .filter(([, count]) => count > 0)
    .map(([id]) => id)
    .sort();
}
