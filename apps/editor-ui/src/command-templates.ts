import type { EventCommand } from "@rpg/schema";

const at = (code: string, params: Record<string, unknown>, indent: number): EventCommand => ({ code, params, indent });

/** 分岐の「開き」になるコマンド。この直後（同じ分岐の中）に別のコマンドを差し込める。 */
const OPENERS = new Set(["ConditionalBranch", "Else", "ChoiceBranch"]);
/** 単独では挿入・削除できない、ブロックの部品。 */
export const BLOCK_PARTS = new Set(["Else", "EndBranch", "ChoiceBranch"]);

/**
 * コマンドを追加するときの並び。分岐を持つコマンドは、対になる部品を一緒に入れる：
 * 条件分岐 = ConditionalBranch / Else / EndBranch、戦闘の処理 = BattleProcessing / ChoiceBranch×3 / EndBranch。
 */
export function commandTemplate(code: string, params: Record<string, unknown>, indent: number): EventCommand[] {
  switch (code) {
    case "ConditionalBranch":
      return [at(code, params, indent), at("Else", {}, indent), at("EndBranch", {}, indent)];
    case "BattleProcessing":
      return [at(code, params, indent), at("ChoiceBranch", { index: 0 }, indent), at("ChoiceBranch", { index: 1 }, indent), at("ChoiceBranch", { index: 2 }, indent), at("EndBranch", {}, indent)];
    default:
      return [at(code, params, indent)];
  }
}

/** 選択中の行の直後に入れるときの位置と字下げ。開きの行なら分岐の中（字下げ +1）、そうでなければ同じ字下げ。 */
export function insertionPoint(commands: readonly EventCommand[], selected: number | undefined): { at: number; indent: number } {
  if (selected === undefined || commands[selected] === undefined) return { at: commands.length, indent: 0 };
  const row = commands[selected]!;
  return { at: selected + 1, indent: OPENERS.has(row.code) ? row.indent + 1 : row.indent };
}

/**
 * 行 `index` を消すときに一緒に消す範囲。分岐の開始（ConditionalBranch / BattleProcessing）なら、対応する EndBranch まで。
 * 部品（Else / ChoiceBranch / EndBranch）は単独では消せない（`undefined`）。
 */
export function removalRange(commands: readonly EventCommand[], index: number): { at: number; count: number } | undefined {
  const row = commands[index];
  if (row === undefined || BLOCK_PARTS.has(row.code)) return undefined;
  if (row.code !== "ConditionalBranch" && row.code !== "BattleProcessing") return { at: index, count: 1 };
  for (let i = index + 1; i < commands.length; i++) {
    const c = commands[i]!;
    if (c.code === "EndBranch" && c.indent === row.indent) return { at: index, count: i - index + 1 };
  }
  return { at: index, count: commands.length - index }; // 閉じていない分岐は末尾まで
}
