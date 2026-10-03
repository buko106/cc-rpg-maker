import { audioRefSchema, nonNegativeInt } from "@rpg/schema";
import * as z from "zod";
import { defineCommand } from "../handler.js";

const audioRefs = (a: z.output<typeof audioRefSchema>) => [{ kind: "asset" as const, id: a.asset }];

/** BGM を切り替える（`fadeMs` かけて）。 */
export const changeBgm = defineCommand({
  code: "ChangeBgm",
  params: z.strictObject({ audio: audioRefSchema, fadeMs: nonNegativeInt.default(0) }),
  meta: { label: "BGM の変更", category: "オーディオ", describe: (p) => `BGM：${p.audio.asset}`, refs: (p) => audioRefs(p.audio) },
  run: (p) => ({ effects: [{ kind: "playBgm", audio: p.audio, fadeMs: p.fadeMs }] }),
});

export const playSe = defineCommand({
  code: "PlaySe",
  params: z.strictObject({ audio: audioRefSchema }),
  meta: { label: "SE の演奏", category: "オーディオ", describe: (p) => `SE：${p.audio.asset}`, refs: (p) => audioRefs(p.audio) },
  run: (p) => ({ effects: [{ kind: "playSe", audio: p.audio }] }),
});

/** BGM をフェードアウトして止める。 */
export const fadeoutBgm = defineCommand({
  code: "FadeoutBgm",
  params: z.strictObject({ fadeMs: nonNegativeInt.default(1000) }),
  meta: { label: "BGM のフェードアウト", category: "オーディオ", describe: (p) => `BGM をフェードアウト：${p.fadeMs}ms`, refs: () => [] },
  run: (p) => ({ effects: [{ kind: "stopBgm", fadeMs: p.fadeMs }] }),
});
