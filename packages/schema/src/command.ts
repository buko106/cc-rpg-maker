import { z } from "zod";
import { nonNegativeInt } from "./common.js";

/**
 * イベントコマンド1行。`schema` は `code` / `params` の中身を検証しない（構造として正しいことだけを保証する）。
 * 中身の検証は `core` のコマンドレジストリが持つ zod スキーマで行う（docs/03-interpreter.md）。
 */
export const eventCommandSchema = z.strictObject({
  /** 例 "ShowText", "ControlSwitches", "plugin:foo/Bar" */
  code: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  /** 分岐ネストの深さ */
  indent: nonNegativeInt,
});
export type EventCommand = z.infer<typeof eventCommandSchema>;
