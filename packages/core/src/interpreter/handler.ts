import type { EventCommand, RefTarget, Result, SchemaIssue } from "@rpg/schema";
import type { z } from "zod";
import type { Effect } from "../effects.js";
import type { EvalError, Value } from "../expression/index.js";
import type { InputFrame } from "../input.js";
import type { ProjectView } from "../project-view.js";
import type { Random } from "../random.js";
import type { GameState } from "../state.js";
import type { InterpreterState, WaitState } from "./state.js";

export interface CommandCtx {
  readonly state: GameState;
  /** 実行中のインタプリタ（`pc` は今のコマンド自身を指す）。 */
  readonly interp: InterpreterState;
  readonly project: ProjectView;
  /** 共有の乱数ストリーム。使うと状態の `rng` が進む。 */
  readonly rng: Random;
  /** 05 の式を `condition` モードで評価する。`scope` は `a`, `b` などの識別子。 */
  readonly eval: (expr: string, scope?: Record<string, Value>) => Result<Value, EvalError>;
  readonly input: InputFrame;
}

export type CommandControl =
  /** pc + 1（既定） */
  | { readonly kind: "next" }
  | { readonly kind: "jump"; readonly pc: number }
  /** pc を進めずに待機する。解除は `resume`（省略時は `wait.kind` に応じた既定処理）が判定する。 */
  | { readonly kind: "wait"; readonly wait: WaitState }
  /** コモンイベント呼び出し。現在位置の次から戻ってくる。 */
  | { readonly kind: "call"; readonly commands: readonly EventCommand[] }
  /** このインタプリタを終了する。 */
  | { readonly kind: "exit" }
  /** 同じ indent の次の `Else` / `EndBranch` まで飛ぶ（その命令は実行される）。無ければ終了する。 */
  | { readonly kind: "skipBlock"; readonly indent: number };

export interface CommandResult {
  /** 変更があれば新しい状態。 */
  readonly state?: GameState;
  readonly effects?: readonly Effect[];
  readonly control?: CommandControl;
  /** `interp.branch` への書き込み（indent → 分岐番号）。 */
  readonly setBranch?: Readonly<Record<number, number>>;
}

export interface CommandHandler<P = unknown> {
  readonly code: string;
  /** params の検証（既定値の適用を含む）とエディタのフォーム生成に使う。 */
  readonly params: z.ZodType<P>;
  readonly meta: {
    readonly label: string;
    readonly category: string;
    /** イベントリストの1行表示 */
    describe(p: P, view: ProjectView): string;
    /** 参照整合性チェック用（schema の `collectRefs` に渡す） */
    refs(p: P): RefTarget[];
  };
  /** 命令を実行する。純関数。 */
  run(p: P, ctx: CommandCtx): CommandResult;
  /** wait 中に毎フレーム呼ばれ、解除条件を判定する。省略時は `wait.kind` に応じた既定処理。 */
  resume?(p: P, ctx: CommandCtx): CommandResult;
}

export type CommandError =
  | { readonly kind: "unknownCommand"; readonly code: string }
  | { readonly kind: "invalidParams"; readonly code: string; readonly issues: SchemaIssue[] };

export interface CommandRegistry {
  /** 同じ code の二重登録は Error（プログラミングエラー）。 */
  register(h: CommandHandler<any>): void;
  get(code: string): CommandHandler | undefined;
  list(): CommandHandler[];
  validate(cmd: EventCommand): Result<void, CommandError>;
}

/** 型推論のためのヘルパ。`params` から `P` を推論してハンドラを返す。 */
export function defineCommand<P>(h: CommandHandler<P>): CommandHandler<P> {
  return h;
}
