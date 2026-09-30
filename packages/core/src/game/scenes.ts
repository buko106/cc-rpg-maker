import type { GameState } from "../state.js";

/** タイトルのコマンド（順序が `scene.cursor` の意味）。表示文言は runtime が `system.terms[key]` から引く。 */
export const TITLE_ITEMS = ["newGame", "continue"] as const;
/** メニューのコマンド。 */
export const MENU_ITEMS = ["item", "status", "save", "load"] as const;

/** セーブ/ロード画面に並べるスロット番号は `SAVE_SLOT_FIRST` から `SAVE_SLOT_COUNT` 個（スロット 0 はオートセーブ用）。 */
export const SAVE_SLOT_FIRST = 1;
export const SAVE_SLOT_COUNT = 10;

/** メニューのアイテム画面に並ぶアイテム ID（所持数 1 以上、ID 順）。 */
export function menuItemIds(state: GameState): string[] {
  return Object.entries(state.party.items)
    .filter(([, count]) => count > 0)
    .map(([id]) => id)
    .sort();
}
