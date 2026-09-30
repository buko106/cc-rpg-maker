import type { Action, Ctx, Effect, GameState } from "@rpg/core";
import type { FrameSpec } from "./frame-spec.js";
import type { AudioOut } from "./ports/audio.js";

/** `GameState.scene.kind`（タイトル・マップ・メニュー・戦闘・ゲームオーバー）。 */
export type SceneKind = GameState["scene"]["kind"];

/** `plugin` Effect の受け口に渡される、ランタイムへの窓口。 */
export interface EffectApi {
  audio: AudioOut;
  /** core の `dispatch` を通して状態を変える（プラグインが `GameState` を直接書き換えることはない）。 */
  dispatch(action: Action): void;
  state(): GameState;
}

/**
 * ランタイムの拡張点（docs/14-plugin-api.md）。`@rpg/plugin-api` が、ロードしたプラグインの登録内容から作る。
 * すべて省略可能で、何も渡さなければ拡張なしのランタイムと同じ挙動になる。
 */
export interface RuntimeExtensions {
  /** `Ctx` を作った直後に呼ばれる。コマンド・式関数の登録や、戦闘ルールの差し替えをして、使う `Ctx` を返す。 */
  setup?(ctx: Ctx): Ctx;
  /** `plugin` Effect の受け口。 */
  onPluginEffect?(effect: Extract<Effect, { kind: "plugin" }>, api: EffectApi): void;
  /** `FrameSpec` の後処理（HUD の追加など）。 */
  afterProject?(scene: SceneKind, frame: FrameSpec, state: GameState): FrameSpec;
}
