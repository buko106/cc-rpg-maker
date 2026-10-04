import { itemIdSchema, nonNegativeInt, variableIdSchema } from "@rpg/schema";
import type { ItemId } from "@rpg/schema";
import * as z from "zod";
import { warn } from "../../effects.js";
import { sortByCategory } from "../../game/item-order.js";
import { openShop } from "../../game/shop.js";
import type { GameState, MessageState } from "../../state.js";
import { defineCommand } from "../handler.js";
import type { CommandCtx, CommandResult } from "../handler.js";

const RETRY: CommandResult = { control: { kind: "wait", wait: { kind: "frames", left: 1 } } };
const WAIT_CHOICE: CommandResult["control"] = { kind: "wait", wait: { kind: "choice" } };
const indentOf = (c: CommandCtx): number => c.interp.commands[c.interp.pc]?.indent ?? 0;

/** メッセージ欄を選択肢・数値入力のために開く。すでに開いていれば（他のインタプリタが使用中）1 フレーム待って再試行する。 */
function openWindow(c: CommandCtx, patch: Partial<MessageState>): GameState | undefined {
  if (c.state.message.open) return undefined;
  return { ...c.state, message: { open: true, owner: c.interp.id, text: "", face: null, position: "bottom", background: "window", choices: null, ...patch } };
}

/** 入力フェーズが `locals.answer` に書いた答え（無ければ `undefined`）。 */
const answerOf = (c: CommandCtx): number | undefined => {
  const a = c.interp.locals["answer"];
  return typeof a === "number" ? a : undefined;
};

/** 答えが書かれる前に窓が閉じられた（セーブからの復元など）とき。 */
const stillOpen = (c: CommandCtx): boolean => c.state.message.open && c.state.message.owner === c.interp.id;

const CLEAR = { answer: undefined, choiceCancel: undefined, choiceIds: undefined } as const;

/**
 * 選択肢を出して選ばせる。選ばれた番号を `branch[indent]` に書き、続く `ChoiceBranch { index }` のうち該当するものだけを実行する（末尾は `EndBranch`）。
 * `cancel` はキャンセルボタンで選ばれたことにする番号（既定は無効）。
 */
export const showChoices = defineCommand({
  code: "ShowChoices",
  params: z.strictObject({
    choices: z.array(z.string()).min(1).meta({ initial: ["はい", "いいえ"] }),
    cancel: z.union([z.literal("disallow"), nonNegativeInt]).default("disallow"),
  }),
  meta: {
    label: "選択肢の表示",
    category: "メッセージ",
    describe: (p) => `選択肢：${p.choices.join(" / ")}`,
    branchLabel: (p, index) => `[${p.choices[index] ?? `選択肢 ${index + 1}`}] のとき`,
    block: { role: "open", close: "EndBranch", bodyFirst: false, dividers: (p) => p.choices.map((_, index) => ({ code: "ChoiceBranch", params: { index } })) },
    refs: () => [],
  },
  run(p, c) {
    const state = openWindow(c, { choices: p.choices, cursor: 0 });
    if (state === undefined) return RETRY;
    return { state, control: WAIT_CHOICE, setLocals: { ...CLEAR, choiceCancel: p.cancel === "disallow" ? undefined : Math.min(p.cancel, p.choices.length - 1) } };
  },
  resume(p, c) {
    if (c.interp.wait.kind === "frames") return { control: { kind: "jump", pc: c.interp.pc } };
    const answer = answerOf(c);
    if (answer === undefined && stillOpen(c)) return { control: WAIT_CHOICE };
    const index = Math.min(Math.max(answer ?? (p.cancel === "disallow" ? 0 : p.cancel), 0), p.choices.length - 1);
    return { setBranch: { [indentOf(c)]: index }, setLocals: CLEAR };
  },
});

/** 数値を入力させて変数に入れる（`digits` 桁）。 */
export const inputNumber = defineCommand({
  code: "InputNumber",
  params: z.strictObject({ variable: variableIdSchema, digits: z.number().int().min(1).max(8).default(4) }),
  meta: {
    label: "数値入力の処理",
    category: "メッセージ",
    describe: (p) => `数値入力：変数 ${p.variable}（${p.digits}桁）`,
    refs: (p) => [{ kind: "variable", id: p.variable }],
  },
  run(p, c) {
    const current = Object.hasOwn(c.state.variables, p.variable) ? (c.state.variables[p.variable] as number) : 0;
    const value = Math.min(Math.max(0, Math.trunc(current)), 10 ** p.digits - 1);
    const state = openWindow(c, { numberInput: { digits: p.digits, value }, cursor: 0 });
    if (state === undefined) return RETRY;
    return { state, control: WAIT_CHOICE, setLocals: CLEAR };
  },
  resume(p, c) {
    if (c.interp.wait.kind === "frames") return { control: { kind: "jump", pc: c.interp.pc } };
    const answer = answerOf(c);
    if (answer === undefined && stillOpen(c)) return { control: WAIT_CHOICE };
    return { state: { ...c.state, variables: { ...c.state.variables, [p.variable]: answer ?? 0 } }, setLocals: CLEAR };
  },
});

/** アイテムの並び（ID の昇順）での番号（1 始まり）。`SelectItem` が変数に入れる値。 */
export const itemNumber = (c: CommandCtx, id: ItemId): number => Object.keys(c.project.project.database.items).sort().indexOf(id) + 1;

/**
 * 所持しているアイテムから 1 つ選ばせ、そのアイテムの番号（ID の昇順での 1 始まり。キャンセルは 0）を変数に入れる。
 * `kind: "key"` は大事なものだけ。持っているものが無ければ、選ばせずに 0 を入れる。
 */
export const selectItem = defineCommand({
  code: "SelectItem",
  params: z.strictObject({ variable: variableIdSchema, kind: z.enum(["key", "all"]).default("key") }),
  meta: {
    label: "アイテム選択の処理",
    category: "メッセージ",
    describe: (p) => `アイテム選択：変数 ${p.variable}`,
    refs: (p) => [{ kind: "variable", id: p.variable }],
  },
  run(p, c) {
    // 消耗品 → 装備 → 大事なもの の順（メニューのアイテム画面と同じ）
    const ids = sortByCategory(
      Object.keys(c.state.party.items)
        .filter((id) => (c.state.party.items[id as ItemId] ?? 0) > 0 && (p.kind === "all" || c.project.item(id as ItemId)?.kind === "key"))
        .sort(),
      c,
    );
    if (ids.length === 0) return { state: { ...c.state, variables: { ...c.state.variables, [p.variable]: 0 } } };
    const state = openWindow(c, { choices: ids.map((id) => c.project.item(id as ItemId)?.name ?? id), cursor: 0 });
    if (state === undefined) return RETRY;
    return { state, control: WAIT_CHOICE, setLocals: { ...CLEAR, choiceCancel: -1, choiceIds: ids } };
  },
  resume(p, c) {
    if (c.interp.wait.kind === "frames") return { control: { kind: "jump", pc: c.interp.pc } };
    const answer = answerOf(c);
    if (answer === undefined && stillOpen(c)) return { control: WAIT_CHOICE };
    const ids = c.interp.locals["choiceIds"];
    const id = answer !== undefined && answer >= 0 && Array.isArray(ids) ? (ids[answer] as ItemId | undefined) : undefined;
    return { state: { ...c.state, variables: { ...c.state.variables, [p.variable]: id === undefined ? 0 : itemNumber(c, id) } }, setLocals: CLEAR };
  },
});

/**
 * ショップ画面（`scene.kind === "shop"`）を開き、閉じるまで待つ。購入・売却（`canSell`）は画面の中で行う（`game/shop.ts`）。
 * 存在しないアイテムは並べない。マップ以外のシーンでは警告してスキップする。
 * 他のインタプリタがメッセージ欄を使っている間は、1 フレーム待って再試行する。
 * セーブから復元したとき（ショップの状態は保存されない）は、マップに戻っているのでそのまま続く。
 */
export const shopProcessing = defineCommand({
  code: "ShopProcessing",
  params: z.strictObject({ goods: z.array(itemIdSchema).min(1), canSell: z.boolean().default(true) }),
  meta: {
    label: "ショップの処理",
    category: "ゲーム進行",
    describe: (p, view) => `ショップ：${p.goods.map((g) => view.project.database.items[g]?.name ?? g).join("、")}${p.canSell ? "" : "（購入のみ）"}`,
    refs: (p) => p.goods.map((id) => ({ kind: "item" as const, id })),
  },
  run(p, c) {
    if (c.state.scene.kind !== "map") return { effects: [warn(`ShopProcessing: マップ以外（${c.state.scene.kind}）ではショップを開けない`)] };
    const goods = p.goods.filter((id) => c.project.item(id) !== undefined);
    if (goods.length === 0) return { effects: [warn("ShopProcessing: 商品が 1 つも存在しない")] };
    if (c.state.message.open) return RETRY;
    return { state: openShop(c.state, goods, p.canSell, c.interp.id), control: { kind: "wait", wait: { kind: "shop" } } };
  },
  resume(_p, c) {
    if (c.interp.wait.kind === "frames") return { control: { kind: "jump", pc: c.interp.pc } }; // メッセージ欄が空くのを待っていた：もう一度開こうとする
    // ショップ（や、途中でゲームオーバー/タイトルに移ったあと）の間は待つ。マップに戻ったら終わり
    return c.state.scene.kind === "map" ? {} : { control: { kind: "wait", wait: c.interp.wait } };
  },
});
