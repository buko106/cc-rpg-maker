import type { ItemId, SwitchId, VariableId } from "@rpg/schema";
import type { Random } from "../random.js";

/** 式から見える戦闘者の読み取り専用ビュー。メンバアクセスはこの属性のみ許可される。 */
export interface BattlerView {
  readonly hp: number;
  readonly mhp: number;
  readonly mp: number;
  readonly mmp: number;
  readonly atk: number;
  readonly def: number;
  readonly mat: number;
  readonly mdf: number;
  readonly agi: number;
  readonly luk: number;
  readonly level: number;
  readonly name: string;
}

export type Value = number | string | boolean | undefined | BattlerView;

/** メンバアクセスのホワイトリスト（`a.constructor` などを拒否するため）。 */
export const BATTLER_MEMBERS: readonly (keyof BattlerView)[] = [
  "hp", "mhp", "mp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk", "level", "name",
];

/** 評価器が返す変更操作。評価器自身は状態を変更しない。 */
export type Mutation =
  | { kind: "setVar"; id: VariableId; value: number }
  | { kind: "setSwitch"; id: SwitchId; value: boolean }
  | { kind: "gainItem"; id: ItemId; count: number };

export interface Scope {
  /** `a`, `b`, … 式から参照できる識別子。 */
  vars: Record<string, Value>;
  variable(id: VariableId): number;
  switch(id: SwitchId): boolean;
  /** `rand()` が使う乱数。評価が進めるのはこれだけ（所有者は呼び出し側）。 */
  rng: Random;
  /** `script` のときだけ副作用関数が使える。 */
  mode: "formula" | "condition" | "script";
}
