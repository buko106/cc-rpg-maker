import * as z from "zod";
import { defineCommand } from "../handler.js";

const params = z.strictObject({ frames: z.number().int().min(0) });

/** `frames` フレーム待つ。0 なら待たない。 */
export const wait = defineCommand({
  code: "Wait",
  params,
  meta: { label: "ウェイト", category: "フロー制御", describe: (p) => `ウェイト：${p.frames}フレーム`, refs: () => [] },
  run: (p) => ({ control: p.frames === 0 ? { kind: "next" } : { kind: "wait", wait: { kind: "frames", left: p.frames } } }),
});
