import type { CommonEventId, EventCommand, EventId, MapId, TroopId } from "@rpg/schema";

/** インタプリタが何を待っているか。待機は Promise ではなく状態で表す。 */
export type WaitState =
  | { readonly kind: "none" }
  | { readonly kind: "frames"; readonly left: number }
  | { readonly kind: "message" }
  | { readonly kind: "choice" }
  | { readonly kind: "move"; readonly who: string }
  | { readonly kind: "battle" }
  | { readonly kind: "shop" }
  | { readonly kind: "transfer" }
  | { readonly kind: "child"; readonly id: string }
  /**
   * プラグインのコマンドが、毎フレーム自分の `resume` で解除を判定する待機（ミニゲームや独自の画面）。`name` はプラグイン名。
   * `resume` を持たないコマンドが発行した場合（プラグインを外したセーブを読んだときなど）は、警告して解除する。
   */
  | { readonly kind: "plugin"; readonly name: string };

export type InterpreterOrigin =
  | { readonly kind: "mapEvent"; readonly mapId: MapId; readonly eventId: EventId; readonly page: number }
  | { readonly kind: "commonEvent"; readonly id: CommonEventId }
  | { readonly kind: "troop"; readonly troopId: TroopId; readonly page: number }
  | { readonly kind: "plugin"; readonly name: string };

export interface CallFrame {
  readonly commands: readonly EventCommand[];
  readonly pc: number;
  readonly branch: Readonly<Record<number, number>>;
}

export interface InterpreterState {
  readonly id: string;
  readonly origin: InterpreterOrigin;
  readonly mode: "normal" | "parallel";
  readonly commands: readonly EventCommand[];
  /** 次に実行する命令のインデックス。`wait.kind !== "none"` の間は変化しない。 */
  readonly pc: number;
  readonly wait: WaitState;
  /** indent → 選択された分岐番号（ConditionalBranch / ShowChoices 用） */
  readonly branch: Readonly<Record<number, number>>;
  readonly callStack: readonly CallFrame[];
  /** プラグイン用 */
  readonly locals: Readonly<Record<string, unknown>>;
}
