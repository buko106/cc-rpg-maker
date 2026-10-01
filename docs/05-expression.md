# 05. `@rpg/core` — 式言語と評価器

## 責務
- ダメージ式・条件式・スクリプトコマンドに使う**小さな安全な式言語**のパーサと評価器。
- ユーザーが書いた文字列を `eval` / `new Function` **を使わずに**評価する。
- 停止性の保証（ループなし、再帰なし、ステップ上限）。

## 非責務
- 汎用スクリプト言語。プラグインの実装言語は TypeScript（14）。

## 依存が許されるパッケージ
なし（core 内部）。

## 言語仕様

```
expr     := ternary
ternary  := or ("?" expr ":" expr)?
or       := and ("||" and)*
and      := eq ("&&" eq)*
eq       := cmp (("==" | "!=") cmp)*
cmp      := add (("<" | "<=" | ">" | ">=") add)*
add      := mul (("+" | "-") mul)*
mul      := unary (("*" | "/" | "%") unary)*
unary    := ("-" | "!") unary | postfix
postfix  := primary ("." IDENT | "(" args ")")*
primary  := NUMBER | STRING | "true" | "false" | IDENT | "(" expr ")"
```

- 値型：`number | string | boolean | Battler(読み取り専用ビュー) | undefined`。
- メンバアクセスはホワイトリスト：`a.atk`, `b.def`, `a.hp`, `a.mhp`, `a.level` 等 `Param` と基本属性のみ。
- 関数呼び出しはレジストリ登録されたもののみ：`v(id)`, `s(id)`, `min`, `max`, `floor`, `ceil`, `round`, `abs`, `rand(min,max)`, `clamp`。
- `Script` コマンドで使う副作用関数（`setVar(id, n)`, `setSwitch(id, b)`, `gainItem(id, n)` など）は `mode: "script"` のときだけ有効。評価結果として「変更操作のリスト」を返し、評価器自身は状態を変更しない。
- `/` のゼロ除算は `0`、`NaN` は `0` に正規化する（式が不正でもゲームが止まらない）。
- ステップ上限 10,000。超えたら `EvalError.kind === "budget"`。

## 公開インターフェース
```ts
export type Value = number | string | boolean | undefined | BattlerView;
export interface BattlerView { readonly hp; mhp; mp; mmp; atk; def; mat; mdf; agi; luk; level; name }

export interface FormulaRegistry {
  registerFn(name: string, fn: (args: Value[], scope: Scope) => Value, opts?: { sideEffect?: boolean }): void;
  has(name: string): boolean;
}
export function createFormulaRegistry(): FormulaRegistry;
export function registerBuiltinFns(r: FormulaRegistry): void;

export interface Scope {
  vars: Record<string, Value>;                       // a, b, ...（イベントの式では `gold` = 所持金も入る）
  variable(id: VariableId): number; switch(id: SwitchId): boolean;
  rng: Random;
  mode: "formula" | "condition" | "script";
}

export type Ast = /* 判別可能ユニオン */;
export function parse(src: string): Result<Ast, ParseError>;               // ParseError には位置情報
export function evaluate(ast: Ast, scope: Scope, reg: FormulaRegistry): Result<{ value: Value; mutations: Mutation[] }, EvalError>;
export function compile(src: string, reg: FormulaRegistry): Result<(scope: Scope) => Result<...>, ParseError>;  // parse をキャッシュ
export type Mutation = { kind: "setVar"; id: VariableId; value: number } | { kind: "setSwitch"; ... } | { kind: "gainItem"; ... };
```

## 不変条件
1. `parse` は任意の文字列に対して例外を投げない（必ず `Result`）。
2. `evaluate` は `Scope` を変更しない。
3. `mode !== "script"` で副作用関数を呼ぶと `EvalError.kind === "sideEffectNotAllowed"`。
4. 同じ `(ast, scope, rng状態)` に対して同じ結果（決定論）。
5. 評価は必ず有限ステップで終了する。

## テスト要件
- パーサ：優先順位・結合性のテーブル駆動テスト、エラー位置の検証。
- fast-check で任意のトークン列を生成しパーサがクラッシュしないことを検証。
- 評価器：ゼロ除算・NaN 正規化・型不一致の扱い。
- RPGツクールMV 互換の代表的な式（`a.atk * 4 - b.def * 2` 等）の期待値テスト。
- ホワイトリスト外のメンバ（`a.constructor` 等）へのアクセスが拒否されること（セキュリティテスト）。

## 完了条件
- 04 の `calcDamage` から利用され、戦闘テストが通る。
- `03` の `ConditionalBranch` / `Script` から利用される。

## 実装メモ（M1 で確定した点）
- 文法は上記のとおり。`&&` `||` `!` `?:` の条件は**真偽値のみ**、算術は**数値のみ**（暗黙の型変換なし。`+` だけは片方が文字列なら連結）。不一致は `EvalError.kind === "typeMismatch"`。
- 未定義の識別子は `unknownIdentifier`、ホワイトリスト外のメンバは `forbiddenMember`、関数名以外の呼び出しは `notCallable`。識別子・メンバの検索は `Object.hasOwn` で行い、`constructor` や `__proto__` には到達できない。
- `registerFn` の関数は第 3 引数 `emit(mutation)` を受け取れる（副作用関数が変更操作を記録する）。`FormulaRegistry` に `get(name)` を追加。引数の不正は `FormulaError` を投げると評価器が `EvalError` に変換する。プラグイン関数が他の例外を投げても `functionError` になり、ゲームは止まらない。
- `evaluate` が進めるのは `scope.rng`（`rand()` の消費）だけで、`vars` / `variable` / `switch` は変更しない。
- ソースは最大 2000 文字、括弧・単項演算子のネストは最大 100（超えると `ParseError.reason` が `tooLong` / `tooDeep`）。手作りの極端に深い AST でスタックが溢れても `budget` エラーとして返る。
- `ParseError` は `{ reason, message, pos, line, column }`。
