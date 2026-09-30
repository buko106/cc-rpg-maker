import type { EventCommand } from "@rpg/schema";
import type { Effect } from "../effects.js";
import type { InputFrame } from "../input.js";
import type { InterpreterOrigin } from "../interpreter/state.js";
import type { ProjectView } from "../project-view.js";
import type { SaveSnapshot } from "../snapshot.js";
import type { GameState } from "../state.js";

export type InterpreterAction =
  | { readonly op: "start"; readonly origin: InterpreterOrigin; readonly commands: readonly EventCommand[]; readonly mode: "normal" | "parallel" }
  | { readonly op: "terminate"; readonly id: string };

/** GameState を変化させる入力単位。戦闘の Action は M4 で追加する。 */
export type Action =
  /** 1フレーム分の入力（プレイヤー操作・メッセージ送りなど）。時間は進めない。 */
  | { readonly type: "input"; readonly input: InputFrame }
  /** 時間を1フレーム進める（イベント実行・移動の補間・場所移動）。 */
  | { readonly type: "tick" }
  /** `project` で新しいゲームを始める。`seed` 省略時は現在のシード。 */
  | { readonly type: "startGame"; readonly project: ProjectView; readonly seed?: string }
  | { readonly type: "loadSnapshot"; readonly snapshot: SaveSnapshot }
  /** メニュー（セーブ/ロード画面）に確認ダイアログを出す。メニュー以外では何もしない。 */
  | { readonly type: "askConfirm"; readonly kind: "save" | "load"; readonly slot: number }
  | ({ readonly type: "interpreter" } & InterpreterAction);

export interface StepResult {
  readonly state: GameState;
  readonly effects: Effect[];
}
