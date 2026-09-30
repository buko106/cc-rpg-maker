import type { EventCommand } from "@rpg/schema";

const at = (code: string, params: Record<string, unknown>, indent: number): EventCommand => ({ code, params, indent });

/** 分岐の「開き」になるコマンド。この直後（同じ分岐の中）に別のコマンドを差し込める。 */
const OPENERS = new Set(["ConditionalBranch", "Else", "ChoiceBranch", "Loop"]);
/** 単独では挿入・削除できない、ブロックの部品（`MoveStep` は移動ルートの内部用）。 */
export const BLOCK_PARTS = new Set(["Else", "EndBranch", "ChoiceBranch", "EndLoop", "MoveStep"]);
/** `EndBranch` で閉じる、分岐を持つコマンド。 */
const BRANCHING = new Set(["ConditionalBranch", "BattleProcessing", "ShowChoices"]);

/** コマンド列の編集操作。連続して適用する（後の操作の位置は、前の操作を適用したあとのもの）。 */
export type CommandOp =
  | { op: "insert"; at: number; commands: EventCommand[] }
  | { op: "remove"; at: number; count: number }
  | { op: "replace"; at: number; command: EventCommand };

/** 操作を順に適用した新しいコマンド列。 */
export function applyOps(commands: readonly EventCommand[], ops: readonly CommandOp[]): EventCommand[] {
  let list = [...commands];
  for (const o of ops) {
    if (o.op === "insert") list = [...list.slice(0, o.at), ...o.commands, ...list.slice(o.at)];
    else if (o.op === "remove") list = [...list.slice(0, o.at), ...list.slice(o.at + o.count)];
    else list = list.map((c, i) => (i === o.at ? o.command : c));
  }
  return list;
}

/**
 * `ShowChoices`（位置 `index`）の選択肢が `count` 個になったとき、対になる `ChoiceBranch` の個数を合わせる操作
 * （足りなければ `EndBranch` の前に空の分岐を足し、多ければ余った分岐を本体ごと消す）。
 */
export function syncChoiceBranches(commands: readonly EventCommand[], index: number, count: number): CommandOp[] {
  const row = commands[index];
  if (row === undefined || row.code !== "ShowChoices") return [];
  const branches: number[] = [];
  let end = -1;
  for (let i = index + 1; i < commands.length; i++) {
    const c = commands[i]!;
    if (c.indent < row.indent) break;
    if (c.indent !== row.indent) continue;
    if (c.code === "ChoiceBranch") branches.push(i);
    else if (c.code === "EndBranch") {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  if (branches.length > count) return [{ op: "remove", at: branches[count]!, count: end - branches[count]! }];
  if (branches.length < count) {
    const added: EventCommand[] = [];
    for (let k = branches.length; k < count; k++) added.push(at("ChoiceBranch", { index: k }, row.indent));
    return [{ op: "insert", at: end, commands: added }];
  }
  return [];
}

/**
 * コマンドを追加するときの並び。分岐を持つコマンドは、対になる部品を一緒に入れる：
 * 条件分岐 = ConditionalBranch / Else / EndBranch、戦闘の処理 = BattleProcessing / ChoiceBranch×3 / EndBranch、
 * 選択肢 = ShowChoices / ChoiceBranch×選択肢の数 / EndBranch、ループ = Loop / EndLoop。
 */
export function commandTemplate(code: string, params: Record<string, unknown>, indent: number): EventCommand[] {
  switch (code) {
    case "ConditionalBranch":
      return [at(code, params, indent), at("Else", {}, indent), at("EndBranch", {}, indent)];
    case "Loop":
      return [at(code, params, indent), at("EndLoop", {}, indent)];
    case "ShowChoices": {
      const choices = Array.isArray(params["choices"]) ? (params["choices"] as unknown[]).length : 1;
      return [at(code, params, indent), ...Array.from({ length: choices }, (_, k) => at("ChoiceBranch", { index: k }, indent)), at("EndBranch", {}, indent)];
    }
    case "BattleProcessing":
      return [at(code, params, indent), at("ChoiceBranch", { index: 0 }, indent), at("ChoiceBranch", { index: 1 }, indent), at("ChoiceBranch", { index: 2 }, indent), at("EndBranch", {}, indent)];
    default:
      return [at(code, params, indent)];
  }
}

/**
 * 分岐の部品（行 `index` の `ChoiceBranch` など）が属する、分岐の開始行の位置。同じ字下げで前にさかのぼり、
 * 部品でない最初の行が開始行（本体は字下げが深いので飛ばす）。見つからなければ `undefined`。
 */
export function branchOwner(commands: readonly EventCommand[], index: number): number | undefined {
  const row = commands[index];
  if (row === undefined) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const c = commands[i]!;
    if (c.indent < row.indent) return undefined;
    if (c.indent === row.indent && !BLOCK_PARTS.has(c.code)) return i;
  }
  return undefined;
}

/** 「文章をすぐ追加」の入力を、1 つずつの「文章の表示」の本文に分ける（ひな形のセリフと同じ規則。editor-core にある）。 */
export { splitMessages } from "@rpg/editor-core";

/** 選択中の行の直後に入れるときの位置と字下げ。開きの行なら分岐の中（字下げ +1）、そうでなければ同じ字下げ。 */
export function insertionPoint(commands: readonly EventCommand[], selected: number | undefined): { at: number; indent: number } {
  if (selected === undefined || commands[selected] === undefined) return { at: commands.length, indent: 0 };
  const row = commands[selected]!;
  return { at: selected + 1, indent: OPENERS.has(row.code) ? row.indent + 1 : row.indent };
}

/**
 * 行 `index` を消すときに一緒に消す範囲。分岐の開始（ConditionalBranch / BattleProcessing / ShowChoices）なら対応する EndBranch まで、
 * Loop なら対応する EndLoop まで。部品（Else / ChoiceBranch / EndBranch / EndLoop）は単独では消せない（`undefined`）。
 */
export function removalRange(commands: readonly EventCommand[], index: number): { at: number; count: number } | undefined {
  const row = commands[index];
  if (row === undefined || BLOCK_PARTS.has(row.code)) return undefined;
  const closer = row.code === "Loop" ? "EndLoop" : BRANCHING.has(row.code) ? "EndBranch" : undefined;
  if (closer === undefined) return { at: index, count: 1 };
  for (let i = index + 1; i < commands.length; i++) {
    const c = commands[i]!;
    if (c.code === closer && c.indent === row.indent) return { at: index, count: i - index + 1 };
  }
  return { at: index, count: commands.length - index }; // 閉じていない分岐は末尾まで
}
