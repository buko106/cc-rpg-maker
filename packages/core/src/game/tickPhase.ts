import type { EventId, MapData } from "@rpg/schema";
import type { Ctx } from "../ctx-types.js";
import { warn } from "../effects.js";
import type { Effect } from "../effects.js";
import type { InputFrame } from "../input.js";
import { isPageRouteOrigin, pageRouteCommands, pageRouteName, runInterpreters, startInterpreter } from "../interpreter/index.js";
import { advanceCharacter, computeCamera, eventsToTrigger, refreshEventPages, startsOnPlayerTouch } from "../map/index.js";
import { battleTick } from "../battle/index.js";
import type { GameState, MapState } from "../state.js";
import type { StepResult } from "./actions.js";
import { enterMap } from "./initial.js";
import { hasNormalInterpreter, startMapEvent } from "./inputPhase.js";

/** 自動実行・並列処理イベントのインタプリタを、現在の有効ページに合わせて起動・停止する。 */
function syncEventInterpreters(state: GameState, map: MapData, ctx: Ctx): GameState {
  const mapId = state.map.mapId;
  // 有効ページが変わった・別マップの並列イベントは止める
  // ページの moveRoute（自律移動）も、そのページが有効な間だけ動かす
  const live = new Set<string>();
  for (const rt of Object.values(state.map.events)) if (rt.pageIndex !== null) live.add(pageRouteName(rt.id, rt.pageIndex));
  const kept = state.interpreters.filter((i) => {
    if (i.mode !== "parallel") return true;
    if (i.origin.kind === "mapEvent") return i.origin.mapId === mapId && state.map.events[i.origin.eventId]?.pageIndex === i.origin.page;
    return !isPageRouteOrigin(i.origin) || live.has((i.origin as { name: string }).name);
  });
  let s = kept.length === state.interpreters.length ? state : { ...state, interpreters: kept };

  for (const id of eventsToTrigger(s, ctx, "parallel")) {
    const rt = s.map.events[id];
    if (rt === undefined || rt.pageIndex === null) continue;
    const running = s.interpreters.some(
      (i) => i.mode === "parallel" && i.origin.kind === "mapEvent" && i.origin.mapId === mapId && i.origin.eventId === id && i.origin.page === rt.pageIndex,
    );
    const page = map.events[id]?.pages[rt.pageIndex];
    if (!running && page) s = startInterpreter(s, { kind: "mapEvent", mapId, eventId: id, page: rt.pageIndex }, page.commands, "parallel");
  }

  for (const rt of Object.values(s.map.events)) {
    if (rt.pageIndex === null) continue;
    const route = map.events[rt.id]?.pages[rt.pageIndex]?.moveRoute;
    const commands = route === undefined ? undefined : pageRouteCommands(rt.id, route);
    if (commands === undefined) continue;
    const name = pageRouteName(rt.id, rt.pageIndex);
    if (!s.interpreters.some((i) => i.origin.kind === "plugin" && i.origin.name === name)) s = startInterpreter(s, { kind: "plugin", name }, commands, "parallel");
  }

  if (!hasNormalInterpreter(s) && s.map.transfer === undefined && !s.message.open) {
    const [autorun] = eventsToTrigger(s, ctx, "autorun");
    if (autorun !== undefined) s = startMapEvent(s, map, autorun);
  }
  return s;
}

/** 予約された場所移動を実行する。マップが未ロードなら `requestMapData` を一度だけ発行して待つ。 */
function applyTransfer(state: GameState, ctx: Ctx): StepResult {
  const t = state.map.transfer;
  if (t === undefined) return { state, effects: [] };
  const target = ctx.project.map(t.to);
  if (target === undefined) {
    if (t.requested) return { state, effects: [] };
    const map: MapState = { ...state.map, transfer: { ...t, requested: true } };
    return { state: { ...state, map }, effects: [{ kind: "requestMapData", mapId: t.to }] };
  }

  const effects: Effect[] = [];
  const x = Math.min(Math.max(t.x, 0), target.width - 1);
  const y = Math.min(Math.max(t.y, 0), target.height - 1);
  if (x !== t.x || y !== t.y) effects.push(warn(`場所移動先 (${t.x}, ${t.y}) が ${t.to} の外なので (${x}, ${y}) に補正した`));

  const player = { ...state.map.player, x, y, realX: x, realY: y, direction: t.dir, moving: false };
  const name = ctx.project.project.maps[t.to]?.name ?? "";
  const entered = enterMap(target, name, player);
  // 元のマップの並列イベントは終了する（移動先で必要なら再び起動される）。移動を待っているインタプリタ自身は残す。
  const interpreters = state.interpreters.filter((i) => !(i.mode === "parallel" && (i.origin.kind === "mapEvent" || isPageRouteOrigin(i.origin))));
  const s = refreshEventPages({ ...state, map: entered, interpreters }, target);
  return { state: { ...s, map: { ...s.map, camera: computeCamera(player, target, ctx.project.project.system) } }, effects };
}

/** 移動の補間を 1 フレーム進める。プレイヤーが到着したら、足元の接触イベント（通常より下/上）を起動する。 */
function advanceMovement(state: GameState, map: MapData): GameState {
  let s = state;
  const events = { ...s.map.events };
  let eventsChanged = false;
  for (const ev of Object.values(events)) {
    if (!ev.moving) continue;
    events[ev.id] = advanceCharacter(ev);
    eventsChanged = true;
  }
  const wasMoving = s.map.player.moving;
  const player = advanceCharacter(s.map.player);
  if (!eventsChanged && player === s.map.player) return s;
  s = { ...s, map: { ...s.map, player, ...(eventsChanged ? { events } : {}) } };

  if (wasMoving && !player.moving && !hasNormalInterpreter(s) && s.map.transfer === undefined) {
    const here: EventId | undefined = Object.values(s.map.events).find(
      (ev) => ev.pageIndex !== null && startsOnPlayerTouch(ev.trigger) && ev.priority !== "same" && ev.x === player.x && ev.y === player.y,
    )?.id;
    if (here !== undefined) s = startMapEvent(s, map, here);
  }
  return s;
}

/**
 * 時間を 1 フレーム進める。タイトル・ゲームオーバーの間は `tick`、メニューとショップではプレイ時間も進む。戦闘中は `battleTick`。順序：tick 加算 → イベントページ更新 → 自動実行/並列イベントの起動 →
 * インタプリタ実行 → イベントページ更新 → 場所移動 → 移動の補間 → カメラ。
 */
export function handleTick(state: GameState, input: InputFrame, ctx: Ctx): StepResult {
  const effects: Effect[] = [];
  // タイトル・メニューの間は世界が止まる（時間だけ進む。プレイ時間はメニュー中も数える）
  if (state.scene.kind === "title") return { state: { ...state, tick: state.tick + 1 }, effects };
  // ショップも同じ（`ShopProcessing` を待つインタプリタは、ショップを閉じるまで動かない）
  if (state.scene.kind === "menu" || state.scene.kind === "shop") return { state: { ...state, tick: state.tick + 1, playtimeTicks: state.playtimeTicks + 1 }, effects };
  if (state.scene.kind === "gameover") return { state: { ...state, tick: state.tick + 1 }, effects };
  // 戦闘中はマップの世界（イベント・移動・並列処理）が止まる。BattleProcessing を待つインタプリタも戦闘が終わるまで動かない。
  if (state.scene.kind === "battle") return battleTick({ ...state, tick: state.tick + 1, playtimeTicks: state.playtimeTicks + 1 }, ctx);
  let s: GameState = { ...state, tick: state.tick + 1, playtimeTicks: state.playtimeTicks + 1 };
  // タイマー（`ControlTimer`）：残りフレームを数え、0 になったら止まる
  if (s.timers.active) s = { ...s, timers: s.timers.ticks <= 1 ? { active: false, ticks: 0 } : { active: true, ticks: s.timers.ticks - 1 } };

  const mapAtStart = s.scene.kind === "map" ? ctx.project.map(s.map.mapId) : undefined;
  if (mapAtStart) {
    s = refreshEventPages(s, mapAtStart);
    s = syncEventInterpreters(s, mapAtStart, ctx);
  }

  const ran = runInterpreters(s, input, ctx);
  s = ran.state;
  effects.push(...ran.effects);
  // イベントが変えたスイッチ等を同じフレームのうちにページへ反映する（次のフレームの入力フェーズで古いページが起動しないように）
  if (mapAtStart && s.map.mapId === mapAtStart.id) s = refreshEventPages(s, mapAtStart);

  if (s.scene.kind === "map") {
    const moved = applyTransfer(s, ctx);
    s = moved.state;
    effects.push(...moved.effects);

    const map = ctx.project.map(s.map.mapId);
    if (map) {
      s = advanceMovement(s, map);
      const camera = computeCamera(s.map.player, map, ctx.project.project.system);
      if (camera.x !== s.map.camera.x || camera.y !== s.map.camera.y) s = { ...s, map: { ...s.map, camera } };
    }
  }
  return { state: s, effects };
}
