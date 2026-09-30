import { assetRefSchema } from "@rpg/schema";
import { z } from "zod";
import { defineCommand } from "../handler.js";

const params = z.strictObject({
  text: z.string().meta({ multiline: true }),
  face: assetRefSchema.optional(),
  position: z.enum(["top", "middle", "bottom"]).default("bottom"),
  background: z.enum(["window", "dim", "transparent"]).default("window"),
});

/**
 * メッセージを表示し、閉じられる（`ok` / `cancel`）まで待つ。
 * 他のインタプリタがメッセージを出している間は、1フレーム待って再試行する。
 */
export const showText = defineCommand({
  code: "ShowText",
  params,
  meta: {
    label: "文章の表示",
    category: "メッセージ",
    describe: (p) => `文章：${p.text.split("\n")[0] ?? ""}`,
    refs: (p) => (p.face ? [{ kind: "asset", id: p.face.asset }] : []),
  },
  run(p, c) {
    if (c.state.message.open) return { control: { kind: "wait", wait: { kind: "frames", left: 1 } } };
    return {
      state: {
        ...c.state,
        message: {
          open: true,
          owner: c.interp.id,
          text: p.text,
          face: p.face ?? null,
          position: p.position,
          background: p.background,
          choices: null,
        },
      },
      control: { kind: "wait", wait: { kind: "message" } },
    };
  },
  resume(_p, c) {
    if (c.interp.wait.kind === "frames") return { control: { kind: "jump", pc: c.interp.pc } }; // 再試行
    const mine = c.state.message.open && c.state.message.owner === c.interp.id;
    return { control: mine ? { kind: "wait", wait: c.interp.wait } : { kind: "next" } };
  },
});
