import { directionSchema, mapIdSchema, nonNegativeInt } from "@rpg/schema";
import * as z from "zod";
import { warn } from "../../effects.js";
import type { Effect } from "../../effects.js";
import { defineCommand } from "../handler.js";
import type { CommandControl, CommandResult } from "../handler.js";
import type { GameState } from "../../state.js";

// `location` はエディタ用のメタデータ：mapId / x / y をマップのクリックで選べる（検証には影響しない）
const params = z
  .strictObject({
    mapId: mapIdSchema,
    x: nonNegativeInt,
    y: nonNegativeInt,
    dir: z.union([directionSchema, z.literal("retain")]).default("retain"),
    fade: z.enum(["black", "white", "none"]).default("black"),
  })
  .meta({ location: true });

/** `fade` が `black` / `white` のときの、暗転・明転それぞれのフレーム数。 */
export const TRANSFER_FADE_TICKS = 15;
/** フェードの段階を覚えておく `interp.locals` のキー（`"out"`：暗転中、`"in"`：明転中）。 */
const PHASE = "transferPlayer.fade";

type Params = z.infer<typeof params>;
const fadeEffect = (p: Params, to: 0 | 1): Effect => ({ kind: "screenFade", to, durationTicks: TRANSFER_FADE_TICKS, ...(p.fade === "white" ? { color: "white" as const } : {}) });
const waitFrames = (left: number): CommandControl => ({ kind: "wait", wait: { kind: "frames", left } });

/**
 * プレイヤーを別のマップ（または同じマップの別の位置）へ移動する。
 * `fade` が `black` / `white` なら、その色へ `TRANSFER_FADE_TICKS` フレームかけて暗転 → 場所移動 → 同じだけかけて明転する
 * （`none` はすぐ切り替える）。暗転・明転は `screenFade` 効果を発行して、その間は待つ（このインタプリタが動いている間はプレイヤーは歩けない）。
 * 場所移動は予約して `transfer` を待つ。実際の切り替えは次の tick で、MapData が未ロードなら
 * `requestMapData` が発行され、ロード完了まで待つ（暗転したまま）。存在しないマップ ID は警告してスキップする。
 * 場所移動を待っていたインタプリタは移動先でも残るので、明転は移動先で行われる。
 */
export const transferPlayer = defineCommand({
  code: "TransferPlayer",
  params,
  meta: {
    label: "場所移動",
    category: "ゲーム進行",
    describe: (p, view) => `場所移動：${view.project.maps[p.mapId]?.name ?? p.mapId} (${p.x}, ${p.y})`,
    refs: (p) => [{ kind: "map", id: p.mapId }],
  },
  run(p, c) {
    if (c.project.project.maps[p.mapId] === undefined) {
      return { effects: [warn(`TransferPlayer: マップ ${p.mapId} が存在しない`)] };
    }
    if (p.fade === "none") return reserve(p, c.state);
    return { effects: [fadeEffect(p, 1)], control: waitFrames(TRANSFER_FADE_TICKS), setLocals: { [PHASE]: "out" } };
  },
  resume(p, c) {
    const { wait } = c.interp;
    if (wait.kind === "frames" && wait.left > 1) return { control: waitFrames(wait.left - 1) };
    // 暗転が終わった → 場所移動を予約する
    if (wait.kind === "frames" && c.interp.locals[PHASE] === "out") return reserve(p, c.state);
    if (wait.kind === "transfer") {
      if (c.state.map.transfer !== undefined) return { control: { kind: "wait", wait } };
      // 移動した → 明転する
      if (p.fade === "none") return {};
      return { effects: [fadeEffect(p, 0)], control: waitFrames(TRANSFER_FADE_TICKS), setLocals: { [PHASE]: "in" } };
    }
    // 明転が終わった（または想定外の待機）→ 次のコマンドへ
    return { setLocals: { [PHASE]: undefined } };
  },
});

/** 場所移動を予約して、その完了を待つ。 */
function reserve(p: Params, state: GameState): CommandResult {
  const dir = p.dir === "retain" ? state.map.player.direction : p.dir;
  return {
    state: { ...state, map: { ...state.map, transfer: { to: p.mapId, x: p.x, y: p.y, dir, fade: p.fade, requested: false } } },
    control: { kind: "wait", wait: { kind: "transfer" } },
  };
}
