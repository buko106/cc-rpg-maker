import { directionSchema, eventIdSchema, nonNegativeInt } from "@rpg/schema";
import { z } from "zod";
import { warn } from "../../effects.js";
import { defineCommand } from "../handler.js";

const params = z.strictObject({
  target: z.union([z.literal("this"), eventIdSchema]).default("this"),
  x: nonNegativeInt,
  y: nonNegativeInt,
  dir: z.union([directionSchema, z.literal("retain")]).default("retain"),
});

/**
 * イベントを、いまのマップの (x, y) へ瞬間移動する（歩かない。移動の補間も無い）。押せる岩を元の位置に戻す仕掛けなどに使う。
 * `target` が `this`（既定）なら、このコマンドを実行しているマップイベント。マップに居ないイベント・マップの外は警告してスキップする。
 */
export const setEventLocation = defineCommand({
  code: "SetEventLocation",
  params,
  meta: {
    label: "イベントの位置設定",
    category: "移動",
    describe: (p) => `イベントの位置：${p.target === "this" ? "このイベント" : `イベント ${p.target}`} → (${p.x}, ${p.y})`,
    refs: () => [],
  },
  run(p, c) {
    const id = p.target === "this" ? (c.interp.origin.kind === "mapEvent" ? c.interp.origin.eventId : undefined) : p.target;
    const ev = id === undefined || !Object.hasOwn(c.state.map.events, id) ? undefined : c.state.map.events[id];
    if (id === undefined || ev === undefined) return { effects: [warn(`SetEventLocation: 対象 "${p.target}" がマップに居ない`)] };
    const map = c.project.map(c.state.map.mapId);
    if (map === undefined || p.x >= map.width || p.y >= map.height) return { effects: [warn(`SetEventLocation: (${p.x}, ${p.y}) がマップの外`)] };
    const moved = { ...ev, x: p.x, y: p.y, realX: p.x, realY: p.y, moving: false, direction: p.dir === "retain" ? ev.direction : p.dir };
    return { state: { ...c.state, map: { ...c.state.map, events: { ...c.state.map.events, [id]: moved } } } };
  },
});
