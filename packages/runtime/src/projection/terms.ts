import type { ProjectView } from "@rpg/core";

/** UI 文言の既定値。`system.terms[key]` があればそちらが優先される。 */
const DEFAULT_TERMS = {
  newGame: "ニューゲーム",
  continue: "コンティニュー",
  item: "アイテム",
  status: "ステータス",
  save: "セーブ",
  load: "ロード",
  gold: "所持金",
  playtime: "プレイ時間",
  level: "Lv",
  hp: "HP",
  mp: "MP",
  exp: "経験値",
  emptySlot: "（空き）",
  incompatible: "（読み込めません）",
  noItems: "（なし）",
  saved: "セーブしました",
  saveFailed: "セーブに失敗しました",
  loadFailed: "ロードに失敗しました",
  mhp: "最大HP",
  mmp: "最大MP",
  atk: "攻撃力",
  def: "防御力",
  mat: "魔力",
  mdf: "魔法防御",
  agi: "敏捷性",
  luk: "運",
} as const;

export type TermKey = keyof typeof DEFAULT_TERMS;

export const term = (view: ProjectView, key: TermKey): string => {
  const custom = Object.hasOwn(view.project.system.terms, key) ? view.project.system.terms[key] : undefined;
  return custom ?? DEFAULT_TERMS[key];
};

/** 一時的なお知らせ（セーブ完了・失敗など）。runtime が持つ見た目だけの状態。 */
export type NoticeKey = "saved" | "saveFailed" | "loadFailed";
