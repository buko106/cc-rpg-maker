import { emptyInput } from "../input.js";
import type { InputFrame } from "../input.js";
import type { Ctx } from "../ctx.js";
import { warn } from "../effects.js";
import { startInterpreter } from "../interpreter/index.js";
import { fromSnapshot } from "../snapshot.js";
import type { GameState } from "../state.js";
import type { Action, StepResult } from "./actions.js";
import { initialState } from "./initial.js";
import { handleInput } from "./inputPhase.js";
import { handleTick } from "./tickPhase.js";

export type { Action, InterpreterAction, StepResult } from "./actions.js";
export { initialState, paramAt, titleState } from "./initial.js";
export { MENU_ITEMS, menuItemIds, SAVE_SLOT_COUNT, SAVE_SLOT_FIRST, TITLE_ITEMS } from "./scenes.js";

/**
 * 1 フレーム進める：`input` を処理してから時間を 1 進める。`runtime` はこれだけを呼ぶ。
 * 純粋関数：`state` を変更せず、同じ `(state, input, ctx)` には同じ結果を返す。`state.tick` はちょうど 1 増える。
 *
 * `dispatch(input)` → `dispatch(tick)` の合成と同じだが、`input` をコマンドにも渡す点だけが異なる
 * （M1 のコマンドは `input` を参照しないので結果は一致する）。
 */
export function step(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const a = handleInput(state, input, ctx);
  const b = handleTick(a.state, input, ctx);
  return { state: b.state, effects: [...a.effects, ...b.effects] };
}

/** 1 つの Action を適用する。純粋関数。 */
export function dispatch(state: GameState, action: Action, ctx: Ctx): StepResult {
  switch (action.type) {
    case "input":
      return handleInput(state, action.input, ctx);
    case "tick":
      return handleTick(state, emptyInput(), ctx);
    case "startGame":
      return { state: initialState({ ...ctx, project: action.project }, action.seed ?? state.rng.seed), effects: [] };
    case "loadSnapshot": {
      const r = fromSnapshot(action.snapshot, ctx);
      if (!r.ok) return { state, effects: [warn(`セーブデータを読み込めない: ${r.error.kind}`)] };
      // 場所移動の予約が残っていれば、要求済みの印を外して `requestMapData` を出し直せるようにする（マップは未ロードかもしれない）
      const transfer = r.value.map.transfer;
      return { state: transfer === undefined ? r.value : { ...r.value, map: { ...r.value.map, transfer: { ...transfer, requested: false } } }, effects: [] };
    }
    case "interpreter":
      if (action.op === "terminate") {
        return { state: { ...state, interpreters: state.interpreters.filter((i) => i.id !== action.id) }, effects: [] };
      }
      return { state: startInterpreter(state, action.origin, action.commands, action.mode), effects: [] };
  }
}
