export type ParseErrorReason =
  | "unexpectedChar"
  | "unterminatedString"
  | "unexpectedToken"
  | "unexpectedEnd"
  | "invalidNumber"
  | "tooLong"
  | "tooDeep";

export interface ParseError {
  reason: ParseErrorReason;
  message: string;
  /** ソース先頭からのオフセット（0 始まり）。 */
  pos: number;
  /** 1 始まり */
  line: number;
  /** 1 始まり */
  column: number;
}

export type EvalErrorKind =
  | "budget"
  | "sideEffectNotAllowed"
  | "typeMismatch"
  | "unknownIdentifier"
  | "unknownFunction"
  | "forbiddenMember"
  | "notCallable"
  | "argument"
  | "functionError";

export interface EvalError {
  kind: EvalErrorKind;
  message: string;
  /** エラー箇所のソースオフセット。 */
  pos: number;
}

/**
 * 式関数の実装が、引数の不正などを評価器に伝えるための例外。評価器が `EvalError` に変換する。
 * （利用者コードに例外を漏らさないための内部機構で、公開 API の戻り値は常に `Result`。）
 */
export class FormulaError extends Error {
  constructor(
    public readonly kind: EvalErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "FormulaError";
  }
}
