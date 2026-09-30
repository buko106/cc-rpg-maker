import { directionSchema, mapIdSchema, nonNegativeInt } from "@rpg/schema";
import { z } from "zod";
import { warn } from "../../effects.js";
import { defineCommand } from "../handler.js";

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

/**
 * プレイヤーを別のマップ（または同じマップの別の位置）へ移動する。
 * 場所移動を予約して `transfer` を待つ。実際の切り替えは次の tick で、MapData が未ロードなら
 * `requestMapData` が発行され、ロード完了まで待つ。存在しないマップ ID は警告してスキップする。
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
    const dir = p.dir === "retain" ? c.state.map.player.direction : p.dir;
    return {
      state: { ...c.state, map: { ...c.state.map, transfer: { to: p.mapId, x: p.x, y: p.y, dir, fade: p.fade, requested: false } } },
      control: { kind: "wait", wait: { kind: "transfer" } },
    };
  },
});
