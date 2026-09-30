import type { Class, Param } from "@rpg/schema";

/** レベル `level` でのパラメータ値。`base + growth * (level - 1)` の切り捨て。 */
export function paramAt(cls: Class | undefined, param: Param, level: number): number {
  const curve = cls?.params[param];
  return curve === undefined ? 0 : Math.floor(curve.base + curve.growth * (level - 1));
}
