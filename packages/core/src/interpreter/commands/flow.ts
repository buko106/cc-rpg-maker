import type { EventCommand } from "@rpg/schema";
import { commonEventIdSchema } from "@rpg/schema";
import * as z from "zod";
import { warn } from "../../effects.js";
import { defineCommand } from "../handler.js";

const empty = z.strictObject({});
const noRefs = () => [];

/** 呼び出しの深さの上限（コモンイベントの再帰でスタックが際限なく伸びないように）。 */
export const MAX_CALL_DEPTH = 16;

/** 注釈。何もしない。 */
export const comment = defineCommand({
  code: "Comment",
  params: z.strictObject({ text: z.string().default("") }),
  meta: { label: "注釈", category: "フロー制御", describe: (p) => `注釈：${p.text.split("\n")[0] ?? ""}`, refs: noRefs },
  run: () => ({}),
});

/**
 * `pc`（`EndLoop` / `BreakLoop` の位置）を内包する `Loop` の位置。ネストした `Loop ... EndLoop` は対応を取ってとばす。
 * 無ければ -1。
 */
export function enclosingLoop(commands: readonly EventCommand[], pc: number): number {
  let depth = 0;
  for (let i = pc - 1; i >= 0; i--) {
    const code = commands[i]!.code;
    if (code === "EndLoop") depth++;
    else if (code === "Loop") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** ループの先頭。`EndLoop` がここへ戻ってくる。 */
export const loop = defineCommand({
  code: "Loop",
  params: empty,
  meta: { label: "ループ", category: "フロー制御", describe: () => "ループ", refs: noRefs, block: { role: "open", close: "EndLoop", bodyFirst: true, dividers: () => [] } },
  run: () => ({}),
});

/** ループの終端：対応する `Loop` へ戻る。`Loop` が無ければ何もしない。 */
export const endLoop = defineCommand({
  code: "EndLoop",
  params: empty,
  meta: { label: "以上繰り返し", category: "フロー制御", describe: () => "以上繰り返し", refs: noRefs, block: { role: "close" } },
  run(_p, c) {
    const start = enclosingLoop(c.interp.commands, c.interp.pc);
    return start < 0 ? {} : { control: { kind: "jump", pc: start } };
  },
});

/** 内側のループを抜ける（対応する `EndLoop` の次へ）。ループの外なら警告して無視する。 */
export const breakLoop = defineCommand({
  code: "BreakLoop",
  params: empty,
  meta: { label: "ループの中断", category: "フロー制御", describe: () => "ループの中断", refs: noRefs },
  run(_p, c) {
    const { commands, pc } = c.interp;
    const start = enclosingLoop(commands, pc);
    if (start < 0) return { effects: [warn("BreakLoop: ループの外にある")] };
    // 入れ子を数えながら、対応する EndLoop を探す
    let depth = 0;
    for (let i = start + 1; i < commands.length; i++) {
      const code = commands[i]!.code;
      if (code === "Loop") depth++;
      else if (code === "EndLoop") {
        if (depth === 0) return { control: { kind: "jump", pc: i + 1 } };
        depth--;
      }
    }
    return { control: { kind: "exit" } };
  },
});

/** このインタプリタを終了する（呼び出し元があっても、すべて終わる）。 */
export const exitEventProcessing = defineCommand({
  code: "ExitEventProcessing",
  params: empty,
  meta: { label: "イベント処理の中断", category: "フロー制御", describe: () => "イベント処理の中断", refs: noRefs },
  run: () => ({ control: { kind: "exit" } }),
});

/** コモンイベントを呼び出す。終わったら次の命令に戻る。存在しない ID と、深すぎる呼び出しは警告してスキップする。 */
export const callCommonEvent = defineCommand({
  code: "CallCommonEvent",
  params: z.strictObject({ id: commonEventIdSchema }),
  meta: {
    label: "コモンイベント",
    category: "フロー制御",
    describe: (p, view) => `コモンイベント：${view.project.database.commonEvents[p.id]?.name ?? p.id}`,
    refs: (p) => [{ kind: "commonEvent", id: p.id }],
  },
  run(p, c) {
    const ev = c.project.commonEvent(p.id);
    if (ev === undefined) return { effects: [warn(`CallCommonEvent: コモンイベント ${p.id} が存在しない`)] };
    if (c.interp.callStack.length >= MAX_CALL_DEPTH) {
      return { effects: [warn(`CallCommonEvent: 呼び出しが深すぎる（${MAX_CALL_DEPTH}）ので ${p.id} をスキップした`)] };
    }
    return { control: { kind: "call", commands: ev.commands } };
  },
});

const labelName = z.string().min(1).default("label");

/** ジャンプ先の目印。何もしない。 */
export const label = defineCommand({
  code: "Label",
  params: z.strictObject({ name: labelName }),
  meta: { label: "ラベル", category: "フロー制御", describe: (p) => `ラベル：${p.name}`, refs: noRefs },
  run: () => ({}),
});

/** 同じコマンド列にある最初の同名ラベルへ飛ぶ。無ければ警告して次へ進む。 */
export const jumpToLabel = defineCommand({
  code: "JumpToLabel",
  params: z.strictObject({ name: labelName }),
  meta: { label: "ラベルジャンプ", category: "フロー制御", describe: (p) => `ラベルジャンプ：${p.name}`, refs: noRefs },
  run(p, c) {
    const at = c.interp.commands.findIndex((cmd) => cmd.code === "Label" && cmd.params["name"] === p.name);
    return at < 0 ? { effects: [warn(`JumpToLabel: ラベル "${p.name}" が無い`)] } : { control: { kind: "jump", pc: at } };
  },
});
