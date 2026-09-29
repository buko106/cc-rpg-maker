import fc from "fast-check";
import { initialState, inputFrame, step } from "@rpg/core";
import type { Button, Ctx, GameState, InputFrame } from "@rpg/core";

const BUTTONS: readonly Button[] = ["up", "down", "left", "right", "ok", "cancel", "menu", "shift", "pageup", "pagedown"];

/** 任意の入力フレーム。`triggered ⊆ pressed` を保つ。 */
export const inputFrameArb: fc.Arbitrary<InputFrame> = fc
  .tuple(fc.subarray([...BUTTONS], { maxLength: 3 }), fc.subarray([...BUTTONS], { maxLength: 2 }))
  .map(([pressed, triggered]) => inputFrame(pressed, triggered));

/** 歩く・決定するが多めの、ゲームらしい入力フレーム。 */
export const gameplayInputArb: fc.Arbitrary<InputFrame> = fc
  .tuple(fc.constantFrom<Button | undefined>("up", "down", "left", "right", undefined), fc.boolean())
  .map(([dir, ok]) => inputFrame(dir ? [dir] : [], ok ? ["ok"] : []));

export const inputSequenceArb = (maxLength = 120): fc.Arbitrary<InputFrame[]> =>
  fc.array(fc.oneof({ weight: 4, arbitrary: gameplayInputArb }, { weight: 1, arbitrary: inputFrameArb }), { maxLength });

/**
 * 到達可能な GameState：`ctx` のプロジェクトのニューゲームから、任意の入力列を流した後の状態。
 * 実際のゲームで起きうる状態だけを生成するので、`step` の不変条件のプロパティテストに使える。
 */
export function reachableStateArb(ctx: Ctx, maxFrames = 120): fc.Arbitrary<GameState> {
  return fc.tuple(fc.string({ maxLength: 8 }), inputSequenceArb(maxFrames)).map(([seed, inputs]) => {
    let state = initialState(ctx, seed);
    for (const input of inputs) state = step(state, input, ctx).state;
    return state;
  });
}
