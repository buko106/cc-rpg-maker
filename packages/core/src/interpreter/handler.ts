import type { EventCommand, RefTarget, Result, SchemaIssue } from "@rpg/schema";
import type { z } from "zod";
import type { Effect } from "../effects.js";
import type { EvalError, Mutation, Value } from "../expression/index.js";
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
  /** 05 の式を `script` モードで評価する（副作用関数が使える）。状態は変えず、変更操作を返す。 */
  readonly script: (expr: string) => Result<{ value: Value; mutations: Mutation[] }, EvalError>;
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
  /** `interp.locals` への書き込み。値が `undefined` のキーは取り除く。 */
  readonly setLocals?: Readonly<Record<string, unknown>>;
}

/**
 * ブロック（分岐・ループ）の構造。開始・区切り・終端は、コマンド列の中で同じ字下げの行として並び、本体はその間に 1 段深く入る。
 * エディタが、対になる行をまとめて追加・削除・移動・コピーするのに使う（実行には使わない）。省略したコマンドは単独の 1 行。
 */
export type CommandBlock<P = unknown> =
  /** ブロックを開く行（条件分岐・選択肢・戦闘の処理・ループなど）。`close` の行（同じ字下げ）までがひとかたまり。 */
  | {
      readonly role: "open";
      /** このブロックを閉じるコマンドの code（`role: "close"` のもの） */
      readonly close: string;
      /** 開始の直後が本体か（条件分岐・ループ）、区切りか（選択肢・戦闘の処理）。本体なら、開始の行の次に足したコマンドはブロックの中に入る。 */
      readonly bodyFirst: boolean;
      /** この設定のとき、開始と終端の間に並べる区切りの行（条件分岐の `Else`、選択肢の数だけの `ChoiceBranch` など）。設定が変わると、エディタが数を合わせる。 */
      dividers(p: P): readonly { readonly code: string; readonly params: Readonly<Record<string, unknown>> }[];
    }
  /** ブロックの途中の区切り（`Else` / `ChoiceBranch`）。直後に本体が続く。単独では追加・削除・移動できない。 */
  | { readonly role: "divider" }
  /** ブロックの終端（`EndBranch` / `EndLoop`）。単独では追加・削除・移動できない。 */
  | { readonly role: "close" };

export interface CommandHandler<P = unknown> {
  readonly code: string;
  /** params の検証（既定値の適用を含む）とエディタのフォーム生成に使う。 */
  readonly params: z.ZodType<P>;
  readonly meta: {
    readonly label: string;
    readonly category: string;
    /** イベントリストの1行表示 */
    describe(p: P, view: ProjectView): string;
    /** 分岐を持つコマンドの、`index` 番目の分岐（`ChoiceBranch`）の行に出す見出し（例：「[はい] のとき」「勝ったとき」）。 */
    branchLabel?(p: P, index: number): string;
    /** 参照整合性チェック用（schema の `collectRefs` に渡す） */
    refs(p: P): RefTarget[];
    /** ブロックの構造（分岐・ループ）。省略は単独の 1 行。 */
    readonly block?: CommandBlock<P>;
    /** 内部用（他のコマンドが展開して作る）。エディタの追加の一覧に出さない。 */
    readonly internal?: boolean;
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
