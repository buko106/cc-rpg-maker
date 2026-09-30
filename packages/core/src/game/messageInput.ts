import type { InputFrame } from "../input.js";
import type { GameState } from "../state.js";
import { IDLE_MESSAGE } from "../state.js";
import type { StepResult } from "./actions.js";

const wrap = (n: number, delta: number, count: number): number => (count <= 0 ? 0 : (((n + delta) % count) + count) % count);

/** 縦方向の入力（押下開始のみ）。 */
const vertical = (input: InputFrame): number => (input.triggered.has("down") ? 1 : 0) - (input.triggered.has("up") ? 1 : 0);
const horizontal = (input: InputFrame): number => (input.triggered.has("right") ? 1 : 0) - (input.triggered.has("left") ? 1 : 0);

/** 答えを持ち主のインタプリタの `locals.answer` に書いて、メッセージ欄を閉じる。 */
function answer(state: GameState, value: number): GameState {
  const owner = state.message.owner;
  const interpreters = state.interpreters.map((i) => (i.id === owner ? { ...i, locals: { ...i.locals, answer: value } } : i));
  return { ...state, interpreters, message: IDLE_MESSAGE };
}

/** キャンセルで選んだことになる番号（コマンドが `locals.choiceCancel` に書く）。無ければ `undefined`。 */
function cancelChoice(state: GameState): number | undefined {
  const c = state.interpreters.find((i) => i.id === state.message.owner)?.locals["choiceCancel"];
  return typeof c === "number" && Number.isInteger(c) ? c : undefined;
}

/**
 * メッセージ表示中の入力。
 * - 選択肢：上下でカーソル、決定で選ぶ、キャンセルは `choiceCancel` があればその番号を選ぶ。
 * - 数値入力：左右で桁、上下で数字（0〜9 を循環）、決定で確定。
 * - それ以外の文章：決定/キャンセルで閉じる。
 */
export function handleMessageInput(state: GameState, input: InputFrame): StepResult {
  const idle: StepResult = { state, effects: [] };
  const m = state.message;
  const set = (patch: Partial<typeof m>): StepResult => ({ state: { ...state, message: { ...m, ...patch } }, effects: [] });

  const cursor = m.cursor ?? 0;
  if (m.choices !== null) {
    const dy = vertical(input);
    if (dy !== 0) return set({ cursor: wrap(cursor, dy, m.choices.length) });
    if (input.triggered.has("ok")) return { state: answer(state, cursor), effects: [] };
    const cancel = input.triggered.has("cancel") ? cancelChoice(state) : undefined;
    return cancel === undefined ? idle : { state: answer(state, cancel), effects: [] };
  }

  if (m.numberInput !== undefined) {
    const { digits, value } = m.numberInput;
    const dx = horizontal(input);
    if (dx !== 0) return set({ cursor: wrap(cursor, dx, digits) });
    const dy = vertical(input);
    if (dy !== 0) {
      const unit = 10 ** (digits - 1 - cursor);
      const digit = Math.floor(value / unit) % 10;
      return set({ numberInput: { digits, value: value + (wrap(digit, -dy, 10) - digit) * unit } }); // 上で増える
    }
    return input.triggered.has("ok") ? { state: answer(state, value), effects: [] } : idle;
  }

  return input.triggered.has("ok") || input.triggered.has("cancel") ? { state: { ...state, message: IDLE_MESSAGE }, effects: [] } : idle;
}
