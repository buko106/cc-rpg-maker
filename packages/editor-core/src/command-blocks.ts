import type { CommandRegistry } from "@rpg/core";
import type { EventCommand } from "@rpg/schema";

/**
 * コマンド列（平らな `EventCommand` の並び）の、ブロック（分岐・ループ）の構造を扱う関数。
 * 構造の知識は、各コマンドの `meta.block` / `meta.internal`（core の 03）から引く。組み込みもプラグインのコマンドも同じ扱い。
 * 位置はすべて配列の添字で、範囲は `Span`（`at` から `count` 行）。ブロックは、開始の行から同じ字下げの終端の行までがひとかたまり。
 */
export type BlockRegistry = Pick<CommandRegistry, "get">;

/** コマンド列の中の、連続した範囲。 */
export interface Span {
  readonly at: number;
  readonly count: number;
}

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

const at = (code: string, params: Record<string, unknown>, indent: number): EventCommand => ({ code, params, indent });
const roleOf = (reg: BlockRegistry, code: string) => reg.get(code)?.meta.block?.role;

/** ブロックの区切り・終端、または内部用のコマンドか（単独では追加・削除・移動できない）。 */
export function isPart(reg: BlockRegistry, code: string): boolean {
  const role = roleOf(reg, code);
  return role === "divider" || role === "close" || reg.get(code)?.meta.internal === true;
}

/** 開始の行 `index` のブロックの最後の行（終端）。閉じていなければ、同じ字下げ以上が続く最後の行。 */
function blockEnd(reg: BlockRegistry, commands: readonly EventCommand[], index: number): number {
  const row = commands[index]!;
  const block = reg.get(row.code)?.meta.block;
  const close = block?.role === "open" ? block.close : undefined;
  let last = index;
  for (let i = index + 1; i < commands.length; i++) {
    const c = commands[i]!;
    if (c.indent < row.indent) break;
    last = i;
    if (c.indent === row.indent && c.code === close) break;
  }
  return last;
}

/**
 * 区切り・終端の行 `index` が属する、ブロックの開始の行の位置。同じ字下げで前にさかのぼり、最初に見つかる開始の行
 * （本体は字下げが深いので飛ばす。別のブロックの終端まで戻ったら、属するものは無い）。見つからなければ `undefined`。
 */
export function blockOwner(reg: BlockRegistry, commands: readonly EventCommand[], index: number): number | undefined {
  const row = commands[index];
  if (row === undefined) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const c = commands[i]!;
    if (c.indent < row.indent) return undefined;
    if (c.indent > row.indent) continue;
    const role = roleOf(reg, c.code);
    if (role === "open") return i;
    if (role === "close") return undefined;
  }
  return undefined;
}

/**
 * 行 `index` を含む、ひとかたまりの範囲。開始の行はブロックの終端まで、区切り・終端の行はそのブロック全体、それ以外は 1 行。
 * 行が無ければ `undefined`。
 */
export function blockSpan(reg: BlockRegistry, commands: readonly EventCommand[], index: number): Span | undefined {
  const row = commands[index];
  if (row === undefined) return undefined;
  const role = roleOf(reg, row.code);
  const start = role === "divider" || role === "close" ? blockOwner(reg, commands, index) : index;
  if (start === undefined || roleOf(reg, commands[start]!.code) !== "open") return { at: index, count: 1 };
  return { at: start, count: blockEnd(reg, commands, start) - start + 1 };
}

/**
 * 行 `index` を消す・動かす・コピーするときの範囲。分岐・ループの開始なら終端まで。
 * 区切り・終端・内部用の行は単独では扱えない（`undefined`）。
 */
export function removalRange(reg: BlockRegistry, commands: readonly EventCommand[], index: number): Span | undefined {
  const row = commands[index];
  return row === undefined || isPart(reg, row.code) ? undefined : blockSpan(reg, commands, index);
}

/**
 * 行 `a` から `b`（順不同）までを選んだときの範囲。ブロックを途中で切らないよう、開始・区切り・終端の行にかかっていれば
 * そのブロック全体まで広げる（本体の中の行だけを選んだときは、そのまま）。
 */
export function selectionSpan(reg: BlockRegistry, commands: readonly EventCommand[], a: number, b: number): Span | undefined {
  if (commands[a] === undefined || commands[b] === undefined) return undefined;
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  for (;;) {
    let nextLo = lo;
    let nextHi = hi;
    for (let i = lo; i <= hi; i++) {
      const s = blockSpan(reg, commands, i)!;
      nextLo = Math.min(nextLo, s.at);
      nextHi = Math.max(nextHi, s.at + s.count - 1);
    }
    if (nextLo === lo && nextHi === hi) return { at: lo, count: hi - lo + 1 };
    lo = nextLo;
    hi = nextHi;
  }
}

/** 開始のコマンドの設定 `params` に対する、区切りの行（条件分岐の `Else` など）。設定が不正なら、そのまま渡してみる。引けなければ空。 */
function dividersOf(reg: BlockRegistry, code: string, params: Record<string, unknown>): { code: string; params: Record<string, unknown> }[] {
  const h = reg.get(code);
  const block = h?.meta.block;
  if (h === undefined || block?.role !== "open") return [];
  const parsed = h.params.safeParse(params);
  try {
    return block.dividers(parsed.success ? parsed.data : params).map((d) => ({ code: d.code, params: { ...d.params } }));
  } catch {
    return [];
  }
}

/**
 * コマンドを追加するときの並び。分岐・ループを開くコマンドは、対になる区切りと終端を一緒に入れる：
 * 条件分岐 = ConditionalBranch / Else / EndBranch、戦闘の処理 = BattleProcessing / ChoiceBranch×3 / EndBranch、
 * 選択肢 = ShowChoices / ChoiceBranch×選択肢の数 / EndBranch、ループ = Loop / EndLoop（`meta.block` による）。
 */
export function commandTemplate(reg: BlockRegistry, code: string, params: Record<string, unknown>, indent: number): EventCommand[] {
  const block = reg.get(code)?.meta.block;
  if (block?.role !== "open") return [at(code, params, indent)];
  return [at(code, params, indent), ...dividersOf(reg, code, params).map((d) => at(d.code, d.params, indent)), at(block.close, {}, indent)];
}

/**
 * 開始の行 `index` の設定が `params` に変わったとき、区切りの行の数を合わせる操作（選択肢の数が変わったときなど）。
 * 足りなければ終端の前に空の区切りを足し、多ければ余った区切りを本体ごと消す。
 */
export function syncDividers(reg: BlockRegistry, commands: readonly EventCommand[], index: number, params: Record<string, unknown>): CommandOp[] {
  const row = commands[index];
  const h = row === undefined ? undefined : reg.get(row.code);
  const block = h?.meta.block;
  if (row === undefined || h === undefined || block?.role !== "open") return [];
  const parsed = h.params.safeParse(params);
  if (!parsed.success) return [];
  let want: ReturnType<typeof dividersOf>;
  try {
    want = block.dividers(parsed.data).map((d) => ({ code: d.code, params: { ...d.params } }));
  } catch {
    return [];
  }
  const have: number[] = [];
  let end = -1;
  for (let i = index + 1; i < commands.length; i++) {
    const c = commands[i]!;
    if (c.indent < row.indent) break;
    if (c.indent !== row.indent) continue;
    if (c.code === block.close) {
      end = i;
      break;
    }
    if (roleOf(reg, c.code) === "divider") have.push(i);
  }
  if (end < 0) return [];
  if (have.length > want.length) return [{ op: "remove", at: have[want.length]!, count: end - have[want.length]! }];
  if (have.length < want.length) return [{ op: "insert", at: end, commands: want.slice(have.length).map((d) => at(d.code, d.params, row.indent)) }];
  return [];
}

/** 選択中の行の直後に入れるときの位置と字下げ。本体が続く行（条件分岐・ループの開始、区切り）ならブロックの中（字下げ +1）、そうでなければ同じ字下げ。 */
export function insertionPoint(reg: BlockRegistry, commands: readonly EventCommand[], selected: number | undefined): { at: number; indent: number } {
  const row = selected === undefined ? undefined : commands[selected];
  if (selected === undefined || row === undefined) return { at: commands.length, indent: 0 };
  const block = reg.get(row.code)?.meta.block;
  const inside = block?.role === "divider" || (block?.role === "open" && block.bodyFirst);
  return { at: selected + 1, indent: inside ? row.indent + 1 : row.indent };
}

/** `span` を前後の行と入れ替える操作と、動かしたあとの範囲。 */
export interface MoveResult {
  ops: CommandOp[];
  span: Span;
}

/**
 * `span`（ブロックを切らない範囲）を、同じ本体の中で 1 つ前（`up`）か後（`down`）のひとかたまりを飛び越えて動かす。
 * 相手が分岐・ループなら、そのブロック全体を飛び越える。本体の端・区切りや終端の行は越えない（`undefined`）。
 */
export function moveSpan(reg: BlockRegistry, commands: readonly EventCommand[], span: Span, dir: "up" | "down"): MoveResult | undefined {
  const lo = span.at;
  const hi = span.at + span.count - 1;
  if (span.count < 1 || commands[lo] === undefined || commands[hi] === undefined) return undefined;
  const level = Math.min(...commands.slice(lo, hi + 1).map((c) => c.indent));
  const neighbour = blockSpan(reg, commands, dir === "up" ? lo - 1 : hi + 1);
  if (neighbour === undefined) return undefined;
  const first = commands[neighbour.at]!;
  if (first.indent !== level || isPart(reg, first.code)) return undefined;
  const rows = commands.slice(neighbour.at, neighbour.at + neighbour.count);
  if (dir === "up") {
    if (neighbour.at + neighbour.count !== lo) return undefined;
    return { ops: [{ op: "remove", at: neighbour.at, count: neighbour.count }, { op: "insert", at: neighbour.at + span.count, commands: rows }], span: { at: neighbour.at, count: span.count } };
  }
  if (neighbour.at !== hi + 1) return undefined;
  return { ops: [{ op: "remove", at: neighbour.at, count: neighbour.count }, { op: "insert", at: lo, commands: rows }], span: { at: lo + neighbour.count, count: span.count } };
}

/** `span` の行を、いちばん浅い字下げが 0 になるようにしてコピーしたもの（クリップボードに入れる形）。 */
export function copyRows(commands: readonly EventCommand[], span: Span): EventCommand[] {
  const rows = commands.slice(span.at, span.at + span.count);
  if (rows.length === 0) return [];
  const base = Math.min(...rows.map((c) => c.indent));
  return rows.map((c) => ({ ...c, indent: c.indent - base }));
}

/** クリップボードの行を、字下げ `indent` に合わせた新しい行にする。 */
export function pasteRows(rows: readonly EventCommand[], indent: number): EventCommand[] {
  return rows.map((c) => ({ ...c, indent: c.indent + indent }));
}
