import type { Direction, EventId, MapData, Tileset } from "@rpg/schema";
import type { Character, EventRuntime } from "../state.js";
import { DIRECTION_VECTOR } from "./character.js";
import { tilesConnect } from "./passability.js";
import type { PassabilityCtx } from "./passability.js";
import { hasInteractiveEvent } from "./slide.js";

/**
 * タイル (x, y) のベルトコンベアの向き（`tileset.conveyor`）。ベルトのタイルを持つ、いちばん上のレイヤのタイルの向きが勝つ。ベルトでなければ `undefined`。
 */
export function conveyorAt(map: MapData, tileset: Tileset, x: number, y: number): Direction | undefined {
  const table = tileset.conveyor;
  if (table === undefined || x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined;
  const index = y * map.width + x;
  for (let i = map.layers.length - 1; i >= 0; i--) {
    const tile = map.layers[i]?.tiles[index] ?? 0;
    if (tile !== 0 && Object.hasOwn(table, tile)) return table[tile];
  }
  return undefined;
}

/** タイルセットに、ベルトのタイルが 1 つでもあるか。無ければ、運ぶ処理は何もしない（状態も入力も、従来どおり）。 */
export const hasConveyor = (tileset: Tileset): boolean => tileset.conveyor !== undefined && Object.keys(tileset.conveyor).length > 0;

/** 運ぶ 1 回の結果：プレイヤーの運ばれる向き（運ばれないなら `undefined`）と、運ばれる箱（イベント id → 向き）。 */
export interface CarryPlan {
  readonly player: Direction | undefined;
  readonly boxes: readonly { readonly id: EventId; readonly dir: Direction }[];
}

export interface CarryInput {
  readonly ctx: PassabilityCtx;
  readonly player: Character;
  /** プレイヤーも運ぶか。歩き終えた直後は運ぶ。方向キーで歩き出した 1 歩では、プレイヤー自身が歩いているので運ばない（箱だけ運ぶ）。 */
  readonly carryPlayer: boolean;
  /** 運ぶ箱か（有効なページが `pushable`）。 */
  readonly isBox: (ev: EventRuntime) => boolean;
  /** この回では運ばないイベント（いま押された箱など）。 */
  readonly skip?: ReadonlySet<EventId>;
}

interface Entry {
  readonly body: "player" | EventRuntime;
  readonly x: number;
  readonly y: number;
  readonly dir: Direction;
}

/**
 * ベルトの上にあるものを、いっせいに 1 タイル運ぶ計画。運ばれるのは、`carryPlayer` ならプレイヤー、そして、通常プライオリティで `through` でない
 * 箱（`isBox`）のうち、ベルトの上にあるもの。**同時に**動くものとして解く（動く候補の集合を、動けないものを外しながら絞っていく）：
 * - 行き先がマップの外・タイルの通行フラグでふさがれている、あるいは（箱だけ）触れる・話しかけると何かが起こるイベントのあるタイルなら、その場に残る
 *   （押せる岩を押せないタイルと同じ）。
 * - 2 つが同じタイルを目指したら、プレイヤー → イベントの順（マップの定義の順）で先のものが動き、後のものはその場に残る。
 * - 行き先に居るものが動かない（通れないイベント・止まっている箱・箱から見てプレイヤー）なら、その場に残る。行き先に居るものも運ばれて
 *   行き先をあけるなら動ける（ベルトに並んだ列は、そろって動く。輪になったベルトの上の列も回る）。互いの場所を入れかわる動きはしない。
 */
export function carryPlan({ ctx, player, carryPlayer, isBox, skip }: CarryInput): CarryPlan {
  const { map, tileset } = ctx;
  const events = Object.values(ctx.events) as EventRuntime[];
  const entries: Entry[] = [];
  if (carryPlayer && !player.through) {
    const dir = conveyorAt(map, tileset, player.x, player.y);
    if (dir !== undefined) entries.push({ body: "player", x: player.x, y: player.y, dir });
  }
  for (const ev of events) {
    if (ev.pageIndex === null || ev.through || ev.priority !== "same" || ev.moving || skip?.has(ev.id) === true || !isBox(ev)) continue;
    const dir = conveyorAt(map, tileset, ev.x, ev.y);
    if (dir !== undefined) entries.push({ body: ev, x: ev.x, y: ev.y, dir });
  }
  const targetOf = (e: Entry): { x: number; y: number } => ({ x: e.x + DIRECTION_VECTOR[e.dir].dx, y: e.y + DIRECTION_VECTOR[e.dir].dy });
  // 場所をふさぐもの：プレイヤーと、通常プライオリティで通れないイベント
  const bodies: Entry["body"][] = ["player", ...events.filter((ev) => ev.pageIndex !== null && !ev.through && ev.priority === "same")];
  const posOf = (b: Entry["body"]): { x: number; y: number } => (b === "player" ? player : b);

  // 1. 行き先のタイル・イベントで決まるもの、同じタイルを目指す順番（先のものだけが動く）
  const claimed = new Set<string>();
  let alive = entries.filter((e) => {
    const t = targetOf(e);
    if (!tilesConnect(map, tileset, e.x, e.y, e.dir)) return false;
    if (e.body !== "player" && hasInteractiveEvent(ctx.events, t.x, t.y, isBox)) return false;
    const key = `${t.x},${t.y}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });
  // 2. 行き先に居るものが動かない・入れかわる、を外していく（動けないものが増えると、その後ろも動けなくなるので、変わらなくなるまで繰り返す）
  for (let changed = true; changed; ) {
    changed = false;
    const next = alive.filter((e) => {
      const t = targetOf(e);
      const blocked = bodies.some((b) => {
        if (b === e.body) return false;
        const at = posOf(b);
        if (at.x !== t.x || at.y !== t.y) return false;
        const other = alive.find((n) => n.body === b);
        if (other === undefined) return true;
        const back = targetOf(other);
        return back.x === e.x && back.y === e.y;
      });
      return !blocked;
    });
    if (next.length !== alive.length) {
      alive = next;
      changed = true;
    }
  }

  let playerDir: Direction | undefined;
  const boxes: { id: EventId; dir: Direction }[] = [];
  for (const e of alive) {
    if (e.body === "player") playerDir = e.dir;
    else boxes.push({ id: e.body.id, dir: e.dir });
  }
  return { player: playerDir, boxes };
}
