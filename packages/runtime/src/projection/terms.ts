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
  confirmOverwrite: "スロット{slot} に上書きしますか？",
  confirmLoad: "未セーブの進行は失われます。ロードしますか？",
  buy: "購入する",
  sell: "売却する",
  quit: "やめる",
  owned: "所持",
  total: "合計",
  yes: "はい",
  no: "いいえ",
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
  // 戦闘：コマンド
  attack: "攻撃",
  skill: "スキル",
  guard: "防御",
  escape: "逃げる",
  gameOver: "ゲームオーバー",
  // 戦闘：ログの文言。`{name}` のような穴は投影時に埋める
  battleAppear: "{name} が あらわれた！",
  battleAppearMany: "{name} たちが あらわれた！",
  actionAttack: "{subject} の こうげき！",
  actionSkill: "{subject} は {skill} を つかった！",
  actionItem: "{subject} は {item} を つかった！",
  actionGuard: "{subject} は みをまもっている。",
  actionEscape: "{subject} は にげだそうとした！",
  damage: "{target} に {amount} の ダメージ！",
  critical: "かいしんの いちげき！",
  healHp: "{target} の HP が {amount} かいふくした！",
  healMp: "{target} の MP が {amount} かいふくした！",
  miss: "{target} には あたらなかった！",
  defeated: "{target} は たおれた！",
  revived: "{target} は ふっかつした！",
  stateAdded: "{target} は {state} になった！",
  stateRemoved: "{target} の {state} が なおった！",
  buffUp: "{target} の {param} が あがった！",
  buffDown: "{target} の {param} が さがった！",
  cannotActState: "{subject} は うごけない！",
  cannotActMp: "{subject} は MP が たりない！",
  cannotActItem: "{subject} は つかえるものが ない！",
  cannotActSkill: "{subject} は その わざを おぼえていない！",
  escapeSuccess: "うまく にげきれた！",
  escapeFail: "しかし にげられなかった！",
  victory: "戦闘に 勝利した！",
  defeat: "全滅してしまった…",
  rewards: "{exp} の 経験値と {gold} の ゴールドを 手に入れた！",
  drop: "{item} を 手に入れた！",
  levelUp: "{actor} は レベル {level} に あがった！",
} as const;

export type TermKey = keyof typeof DEFAULT_TERMS;

/** 用語の `{name}` を値で置き換える（値が無い穴はそのまま残す）。 */
export const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : whole));

export const term = (view: ProjectView, key: TermKey): string => {
  const custom = Object.hasOwn(view.project.system.terms, key) ? view.project.system.terms[key] : undefined;
  return custom ?? DEFAULT_TERMS[key];
};

/** 一時的なお知らせ（セーブ完了・失敗など）。runtime が持つ見た目だけの状態。 */
export type NoticeKey = "saved" | "saveFailed" | "loadFailed";
