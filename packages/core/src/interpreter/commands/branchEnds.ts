import { nonNegativeInt } from "@rpg/schema";
import { z } from "zod";
import { defineCommand } from "../handler.js";

const empty = z.strictObject({});
const noRefs = () => [];

/**
 * 分岐の途中の区切り。真の側を実行し終えてここに来たら（`branch[indent] === 0`）、`EndBranch` まで飛ぶ。
 * 偽の側から飛んできたとき（`branch[indent] === 1`）は、続く本体を実行する。
 */
export const elseCommand = defineCommand({
  code: "Else",
  params: empty,
  meta: { label: "それ以外のとき", category: "フロー制御", describe: () => "それ以外のとき", refs: noRefs, block: { role: "divider" } },
  run(_p, c) {
    const indent = c.interp.commands[c.interp.pc]?.indent ?? 0;
    return { control: c.interp.branch[indent] === 1 ? { kind: "next" } : { kind: "skipBlock", indent } };
  },
});

/** 分岐の終端。何もしない。 */
export const endBranch = defineCommand({
  code: "EndBranch",
  params: empty,
  meta: { label: "分岐終了", category: "フロー制御", describe: () => "分岐終了", refs: noRefs, block: { role: "close" } },
  run: () => ({}),
});

/**
 * 複数の分岐のうち `index` 番目の本体。`branch[indent]`（選ばれた番号。戦闘の結果など）が `index` と一致するときだけ
 * 続く本体を実行し、違えば次の `ChoiceBranch` / `EndBranch` まで飛ぶ。
 */
export const choiceBranch = defineCommand({
  code: "ChoiceBranch",
  params: z.strictObject({ index: nonNegativeInt }),
  meta: { label: "分岐", category: "フロー制御", describe: (p) => `分岐 ${p.index}`, refs: noRefs, block: { role: "divider" } },
  run(p, c) {
    const indent = c.interp.commands[c.interp.pc]?.indent ?? 0;
    return { control: c.interp.branch[indent] === p.index ? { kind: "next" } : { kind: "skipBlock", indent } };
  },
});
