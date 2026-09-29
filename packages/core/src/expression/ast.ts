export type BinaryOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";

/** すべてのノードは `pos`（ソースオフセット）を持つ。 */
export type Ast =
  | { readonly kind: "number"; readonly value: number; readonly pos: number }
  | { readonly kind: "string"; readonly value: string; readonly pos: number }
  | { readonly kind: "boolean"; readonly value: boolean; readonly pos: number }
  | { readonly kind: "ident"; readonly name: string; readonly pos: number }
  | { readonly kind: "unary"; readonly op: "-" | "!"; readonly arg: Ast; readonly pos: number }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Ast; readonly right: Ast; readonly pos: number }
  | { readonly kind: "ternary"; readonly cond: Ast; readonly then: Ast; readonly else: Ast; readonly pos: number }
  | { readonly kind: "member"; readonly object: Ast; readonly prop: string; readonly pos: number }
  | { readonly kind: "call"; readonly callee: Ast; readonly args: readonly Ast[]; readonly pos: number };
