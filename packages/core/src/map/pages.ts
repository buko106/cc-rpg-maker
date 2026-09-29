import type { EventId, EventPage, MapData, MapEvent, MapId, PageCondition } from "@rpg/schema";
import type { Ctx } from "../ctx.js";
import type { EventRuntime, GameState } from "../state.js";
import { selfSwitchKey } from "../state.js";

function holds(cond: PageCondition, state: GameState, mapId: MapId, eventId: EventId): boolean {
  switch (cond.kind) {
    case "switch":
      return (Object.hasOwn(state.switches, cond.id) && state.switches[cond.id] === true) === cond.value;
    case "variable": {
      const v = Object.hasOwn(state.variables, cond.id) ? (state.variables[cond.id] as number) : 0;
      return cond.op === ">=" ? v >= cond.value : cond.op === "<=" ? v <= cond.value : v === cond.value;
    }
    case "selfSwitch":
      return (state.selfSwitches[selfSwitchKey(mapId, eventId, cond.key)] === true) === cond.value;
    case "item":
      return (Object.hasOwn(state.party.items, cond.id) ? (state.party.items[cond.id] as number) : 0) > 0;
    case "actor":
      return state.party.members.includes(cond.id);
  }
}

/** 現在有効なページの番号。後ろのページほど優先され、どれも満たさなければ `undefined`。 */
export function activePageIndex(ev: MapEvent, state: GameState, mapId: MapId): number | undefined {
  for (let i = ev.pages.length - 1; i >= 0; i--) {
    if (ev.pages[i]!.conditions.every((c) => holds(c, state, mapId, ev.id))) return i;
  }
  return undefined;
}

/** 現在有効なページ。後ろのページほど優先される。 */
export function activePage(ev: MapEvent, state: GameState, mapId: MapId): EventPage | undefined {
  const i = activePageIndex(ev, state, mapId);
  return i === undefined ? undefined : ev.pages[i];
}

/** 現在のマップで、有効なページのトリガが `kind` のイベント ID（マップ定義の順）。マップが未ロードなら空。 */
export function eventsToTrigger(state: GameState, ctx: Ctx, kind: EventPage["trigger"]): EventId[] {
  const map = ctx.project.map(state.map.mapId);
  if (map === undefined) return [];
  return Object.values(map.events)
    .filter((ev) => activePage(ev, state, state.map.mapId)?.trigger === kind)
    .map((ev) => ev.id);
}

function runtimeForPage(rt: EventRuntime, page: EventPage | undefined, index: number | undefined): EventRuntime {
  const { graphic: _old, ...rest } = rt;
  if (page === undefined || index === undefined) {
    return { ...rest, pageIndex: null, trigger: null, priority: "same", through: false };
  }
  return {
    ...rest,
    pageIndex: index,
    trigger: page.trigger,
    priority: page.priority,
    through: page.through,
    direction: page.graphic?.direction ?? rt.direction,
    ...(page.graphic ? { graphic: { asset: page.graphic.asset, index: page.graphic.index } } : {}),
  };
}

/**
 * 現在のスイッチ・変数・セルフスイッチ・所持品に基づいて、各イベントの有効ページを更新する。
 * ページが変わらないイベントのオブジェクトはそのまま使い回す。
 */
export function refreshEventPages(state: GameState, map: MapData): GameState {
  let changed = false;
  const events = { ...state.map.events };
  for (const ev of Object.values(map.events)) {
    const rt = events[ev.id];
    if (rt === undefined) continue;
    const index = activePageIndex(ev, state, state.map.mapId);
    if ((index ?? null) === rt.pageIndex) continue;
    events[ev.id] = runtimeForPage(rt, index === undefined ? undefined : ev.pages[index], index);
    changed = true;
  }
  return changed ? { ...state, map: { ...state.map, events } } : state;
}

/** MapData からイベントの初期実行時状態を作る（ページは未評価）。 */
export function initialEventRuntimes(map: MapData): Record<EventId, EventRuntime> {
  const events: Record<EventId, EventRuntime> = {};
  for (const ev of Object.values(map.events)) {
    events[ev.id] = {
      id: ev.id, x: ev.x, y: ev.y, realX: ev.x, realY: ev.y, direction: "down", moving: false, speed: 4,
      through: false, pageIndex: null, trigger: null, priority: "same",
    };
  }
  return events;
}
