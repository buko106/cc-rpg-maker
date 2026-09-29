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
  meta: { label: "それ以外のとき", category: "フロー制御", describe: () => "それ以外のとき", refs: noRefs },
  run(_p, c) {
    const indent = c.interp.commands[c.interp.pc]?.indent ?? 0;
    return { control: c.interp.branch[indent] === 1 ? { kind: "next" } : { kind: "skipBlock", indent } };
  },
});

/** 分岐の終端。何もしない。 */
export const endBranch = defineCommand({
  code: "EndBranch",
  params: empty,
  meta: { label: "分岐終了", category: "フロー制御", describe: () => "分岐終了", refs: noRefs },
  run: () => ({}),
});
