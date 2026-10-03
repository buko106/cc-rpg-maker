import { eventIdSchema, moveRouteSchema, moveStepSchema } from "@rpg/schema";
import type { Direction, EventCommand, EventId, MoveRoute } from "@rpg/schema";
import * as z from "zod";
import { warn } from "../../effects.js";
import { canPass, chaseDirection, currentMap, DIRECTION_VECTOR, moveCharacter, startsOnEventTouch } from "../../map/index.js";
import type { PassabilityCtx } from "../../map/index.js";
import type { Character, EventRuntime, GameState } from "../../state.js";
import { defineCommand } from "../handler.js";
import type { CommandCtx, CommandResult } from "../handler.js";
import { startInterpreter } from "../run.js";
import type { InterpreterOrigin, InterpreterState } from "../state.js";

/** 通れない相手に突き当たったまま待ち続けてよいフレーム数（超えたらその歩みをあきらめる）。 */
export const MAX_BLOCKED_FRAMES = 60;

const target = z.union([z.literal("player"), z.literal("this"), eventIdSchema]);

/** ルートの動かし先。`this` はこのコマンドを実行しているマップイベント。`undefined` は解決できない。 */
function resolveWho(t: z.output<typeof target>, c: CommandCtx): string | undefined {
  if (t === "player") return "player";
  if (t === "this") return c.interp.origin.kind === "mapEvent" ? c.interp.origin.eventId : undefined;
  return Object.hasOwn(c.state.map.events, t) ? t : undefined;
}

const characterOf = (state: GameState, who: string): Character | undefined =>
  who === "player" ? state.map.player : Object.hasOwn(state.map.events, who) ? state.map.events[who as keyof GameState["map"]["events"]] : undefined;

function withCharacter(state: GameState, who: string, ch: Character): GameState {
  if (who === "player") return { ...state, map: { ...state.map, player: ch } };
  const id = who as keyof GameState["map"]["events"];
  const ev = state.map.events[id];
  return ev === undefined ? state : { ...state, map: { ...state.map, events: { ...state.map.events, [id]: { ...ev, ...ch } } } };
}

/**
 * 歩む方向：`toward` / `away` はプレイヤーとの位置関係で（大きい軸の側）、`chase` は通れる道をたどる最短経路の最初の 1 歩
 * （たどり着けないときは `toward` と同じ）、`random` は共有の乱数から決める。
 */
function pickDirection(dir: Direction | "random" | "toward" | "away" | "chase", who: string, ch: Character, c: CommandCtx, pass: PassabilityCtx): Direction {
  if (dir === "random") return (["down", "left", "right", "up"] as const)[c.rng.int(0, 3)]!;
  if (dir !== "toward" && dir !== "away" && dir !== "chase") return dir;
  const p = c.state.map.player;
  const dx = p.x - ch.x;
  const dy = p.y - ch.y;
  if (who === "player" || (dx === 0 && dy === 0)) return ch.direction;
  if (dir === "chase") {
    const path = chaseDirection(ch, p, pass);
    if (path !== undefined) return path;
  }
  const toward: Direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  return dir === "away" ? ({ up: "down", down: "up", left: "right", right: "left" } as const)[toward] : toward;
}

/**
 * 「イベントから接触」（`eventTouch` / `eventSight`）のイベントが、`dir` へ歩むとプレイヤーの居るタイルに入るところか。
 * 通常プライオリティのイベントだけ。プレイヤーが居なければ進めるとき（壁越しではない）に限る。`through` でも触れる。
 */
function reachesPlayer(state: GameState, who: string, dir: Direction, ctx: PassabilityCtx): EventRuntime | undefined {
  if (who === "player" || !Object.hasOwn(state.map.events, who)) return undefined;
  const ev = state.map.events[who as EventId]!;
  if (ev.pageIndex === null || !startsOnEventTouch(ev.trigger) || ev.priority !== "same") return undefined;
  const { dx, dy } = DIRECTION_VECTOR[dir];
  const { player } = state.map;
  if (ev.x + dx !== player.x || ev.y + dy !== player.y) return undefined;
  return canPass(ctx.map, ctx.tileset, ctx.events, ev, dir) ? ev : undefined;
}

/**
 * 向こうから触れたイベントのページを、通常のイベントとして起動する（プレイヤーから触れたときと同じ）。
 * 通常のイベントの実行中・メッセージ表示中・場所移動の予約中は起動しない。
 */
function startTouchedEvent(state: GameState, ev: EventRuntime, ctx: PassabilityCtx): GameState {
  if (ev.pageIndex === null || state.message.open || state.map.transfer !== undefined || state.interpreters.some((i) => i.mode === "normal")) return state;
  const page = ctx.map.events[ev.id]?.pages[ev.pageIndex];
  if (page === undefined) return state;
  return startInterpreter(state, { kind: "mapEvent", mapId: state.map.mapId, eventId: ev.id, page: ev.pageIndex }, page.commands, "normal");
}

const stepParams = z.strictObject({
  who: z.string(),
  step: moveStepSchema,
  skippable: z.boolean().default(false),
  /** ページの `moveRoute`（自律移動）の 1 歩。イベントの実行中・メッセージ表示中・`SetMoveRoute` の実行中は止まり、プレイヤーの居る所へは入らず、通れなくても警告しない。 */
  auto: z.boolean().default(false),
  /** ターン制（`pace: "playerStep"`）のルートの 1 歩。通れなくても待たずに、その手をあきらめる（警告も出さない）。 */
  paced: z.boolean().default(false),
});

const PAGE_ROUTE = "pageRoute:";
/** ページの `moveRoute` を動かす並列インタプリタの名前（`plugin` 起点）。 */
export const pageRouteName = (eventId: EventId, page: number): string => `${PAGE_ROUTE}${eventId}:${page}`;
/** その起点が、ページの `moveRoute` を動かすものか。 */
export const isPageRouteOrigin = (origin: InterpreterOrigin): boolean => origin.kind === "plugin" && origin.name.startsWith(PAGE_ROUTE);

/** `repeat` でない自律移動が終わったあとに、インタプリタを生かしておく待ち（ページが変わるまで再起動させない）。 */
const FOREVER = 2 ** 31 - 1;

/**
 * ページの `moveRoute` を、並列インタプリタで動かすコマンド列に展開する。空のルートは `undefined`。
 * `repeat` は繰り返し（1 周ごとに 1 フレーム待つので、時間のかからない歩だけのルートでも詰まらない）、
 * そうでなければ一度だけ実行して、ページが変わるまで待ち続ける。
 */
export function pageRouteCommands(eventId: EventId, route: MoveRoute): EventCommand[] | undefined {
  if (route.steps.length === 0) return undefined;
  const indent = route.repeat ? 1 : 0;
  const steps = routeSteps(eventId, route, indent, true);
  const last = (s: MoveRoute["steps"][number]): EventCommand => ({ code: "MoveStep", params: { who: eventId, step: s, skippable: route.skippable, auto: true }, indent });
  if (!route.repeat) return [...steps, last({ kind: "wait", frames: FOREVER })];
  return [{ code: "Loop", params: {}, indent: 0 }, ...steps, last({ kind: "wait", frames: 1 }), { code: "EndLoop", params: {}, indent: 0 }];
}

/**
 * ルートの歩みを `MoveStep` に展開する。ターン制（`pace: "playerStep"`）のルートは、`move` の前に 1 手待ち、
 * `wait` は `frames` 手待つ（0 なら何もしない）。`turn` と `speed` は時間がかからない。
 */
function routeSteps(who: string, route: MoveRoute, indent: number, auto: boolean): EventCommand[] {
  const paced = route.pace === "playerStep";
  const out: EventCommand[] = [];
  for (const step of route.steps) {
    if (paced && step.kind === "wait") {
      if (step.frames > 0) out.push({ code: "WaitPlayerStep", params: { turns: step.frames }, indent });
      continue;
    }
    if (paced && step.kind === "move") out.push({ code: "WaitPlayerStep", params: { turns: 1 }, indent });
    out.push({ code: "MoveStep", params: { who, step, skippable: route.skippable, ...(auto ? { auto } : {}), ...(paced ? { paced } : {}) }, indent });
  }
  return out;
}

/** 自律移動を止めておくべきときか：通常のイベントの実行中、メッセージ表示中、場所移動の予約中、`SetMoveRoute` でそのイベントを動かしている間。 */
function autoPaused(state: GameState, who: string): boolean {
  if (state.message.open || state.map.transfer !== undefined) return true;
  const forced = originName(who);
  return state.interpreters.some((i) => i.mode === "normal" || (i.origin.kind === "plugin" && i.origin.name === forced));
}

/**
 * 内部用：移動ルートの 1 歩。`SetMoveRoute` がルートを展開して作る。
 * 歩みは前の移動が終わってから行い、歩いたらそれが終わるまで待つ。通れないときは（`skippable` なら）あきらめ、
 * そうでなければ通れるようになるのを待つ（`MAX_BLOCKED_FRAMES` を超えたらあきらめる）。
 * 動かす対象がマップに居なくなったら、ルートごと終了する。
 */
export const moveStep = defineCommand({
  code: "MoveStep",
  params: stepParams,
  meta: { label: "移動ルートの 1 歩", category: "移動", describe: (p) => `移動ルート：${p.step.kind}`, refs: () => [], internal: true },
  run(p, c) {
    const ch = characterOf(c.state, p.who);
    if (ch === undefined) return { control: { kind: "exit" } };
    if (ch.moving || (p.auto && autoPaused(c.state, p.who))) return { control: { kind: "wait", wait: { kind: "frames", left: 1 } }, setLocals: { retry: true } };
    const step = p.step;
    switch (step.kind) {
      case "turn":
        return { state: withCharacter(c.state, p.who, { ...ch, direction: step.dir }) };
      case "speed":
        return { state: withCharacter(c.state, p.who, { ...ch, speed: step.value as Character["speed"] }) };
      case "wait":
        return step.frames === 0 ? {} : { control: { kind: "wait", wait: { kind: "frames", left: step.frames } }, setLocals: { retry: undefined } };
      case "move": {
        const map = currentMap(c.project, c.state);
        if (map === undefined) return {};
        const pass: PassabilityCtx = { map, tileset: c.project.tileset(map.tileset) ?? { id: "" as never, name: "", passage: [] }, events: c.state.map.events };
        const dir = pickDirection(step.dir, p.who, ch, c, pass);
        // 「イベントから接触」のイベントは、プレイヤーに触れたらそのページを始める（入らずに、その場でプレイヤーの方を向く）
        const touching = reachesPlayer(c.state, p.who, dir, pass);
        let moved = touching === undefined ? moveCharacter(ch, dir, pass) : { ...ch, direction: dir };
        // 自律移動のイベントは、プレイヤーの居るタイルへは入らない（プレイヤーは通行判定の対象ではないので、ここで見る）
        const player = c.state.map.player;
        if (p.auto && !ch.through && (!("priority" in ch) || ch.priority === "same") && moved.x === player.x && moved.y === player.y) moved = { ...ch, direction: dir };
        const blocked = moved.x === ch.x && moved.y === ch.y;
        const turned = withCharacter(c.state, p.who, moved);
        const next = touching === undefined ? turned : startTouchedEvent(turned, touching, pass);
        if (!blocked) return { state: next, control: { kind: "wait", wait: { kind: "move", who: p.who } } };
        // ターン制のルートは、通れなければその手をあきらめる（待っていると、プレイヤーの手とずれていく）
        if (p.paced) return { state: next, setLocals: { retry: undefined, blocked: undefined } };
        // 自律移動で `skippable` でないルートは、通れるようになるまで待ち続ける（あきらめると、相対的な歩みの列がずれていく）
        if (p.auto && !p.skippable) return { state: next, control: { kind: "wait", wait: { kind: "frames", left: 1 } }, setLocals: { retry: true } };
        const waited = typeof c.interp.locals["blocked"] === "number" ? (c.interp.locals["blocked"] as number) : 0;
        if (p.skippable || waited >= MAX_BLOCKED_FRAMES) {
          return { state: next, setLocals: { blocked: undefined }, ...(p.skippable ? {} : { effects: [warn(`MoveStep: ${p.who} が ${dir} に進めないのであきらめた`)] }) };
        }
        return { state: next, control: { kind: "wait", wait: { kind: "frames", left: 1 } }, setLocals: { retry: true, blocked: waited + 1 } };
      }
    }
  },
  resume(_p, c) {
    const { wait } = c.interp;
    if (wait.kind === "move") {
      const ch = characterOf(c.state, wait.who);
      return ch?.moving === true ? { control: { kind: "wait", wait } } : {};
    }
    if (wait.kind !== "frames") return {};
    if (c.interp.locals["retry"] === true) return { control: { kind: "jump", pc: c.interp.pc }, setLocals: { retry: undefined } };
    return wait.left <= 1 ? {} : { control: { kind: "wait", wait: { kind: "frames", left: wait.left - 1 } } };
  },
});

/**
 * 内部用：ターン制（`pace: "playerStep"`）のルートが、プレイヤーの手を `turns` 手ぶん待つ（`MapState.turns` が増えるのを待つ）。
 * 数えはじめは、このコマンドが最初に動いた時点の手数。そのあとは、使った手を 1 手ずつ消費していく（まとめて進んだ手も取りこぼさない）。
 */
export const waitPlayerStep = defineCommand({
  code: "WaitPlayerStep",
  params: z.strictObject({ turns: z.number().int().min(1).default(1) }),
  meta: { label: "プレイヤーの手を待つ", category: "移動", describe: (p) => `プレイヤーの ${p.turns} 手を待つ`, refs: () => [], internal: true },
  run(p, c) {
    const turns = c.state.map.turns ?? 0;
    const consumed = typeof c.interp.locals["consumed"] === "number" ? (c.interp.locals["consumed"] as number) : turns;
    const goal = consumed + p.turns;
    if (turns >= goal) return { setLocals: { consumed: goal, retry: undefined } };
    return { control: { kind: "wait", wait: { kind: "frames", left: 1 } }, setLocals: { consumed, retry: true } };
  },
  resume(_p, c) {
    if (c.interp.wait.kind === "frames" && c.interp.locals["retry"] === true) return { control: { kind: "jump", pc: c.interp.pc }, setLocals: { retry: undefined } };
    return {};
  },
});

/** `SetMoveRoute` が動かしている、ターン制（`pace: "playerStep"`）のルートのインタプリタか。動かしている対象のイベント（プレイヤーなら `"player"`）を返す。 */
export function pacedRouteTarget(i: InterpreterState): string | undefined {
  if (i.origin.kind !== "plugin" || !i.origin.name.startsWith(FORCED_ROUTE)) return undefined;
  return i.commands.some((c) => c.code === "WaitPlayerStep") ? i.origin.name.slice(FORCED_ROUTE.length) : undefined;
}

const params = z.strictObject({ target: target.default("this"), route: moveRouteSchema, wait: z.boolean().default(false) });

const FORCED_ROUTE = "moveRoute:";
const originName = (who: string): string => `${FORCED_ROUTE}${who}`;

/**
 * 移動ルートを実行させる。ルートは `MoveStep` に展開する。
 * - `wait` が真（で `repeat` でない）：このインタプリタの中で 1 歩ずつ実行し、終わるまで待つ。
 * - それ以外：並列のインタプリタで実行し、すぐ次の命令へ進む。同じ対象の実行中のルートは置き換える。`repeat` は繰り返し続ける。
 */
export const setMoveRoute = defineCommand({
  code: "SetMoveRoute",
  params,
  meta: {
    label: "移動ルートの設定",
    category: "移動",
    describe: (p) => `移動ルート：${p.target === "this" ? "このイベント" : p.target === "player" ? "プレイヤー" : `イベント ${p.target}`}（${p.route.steps.length}歩）`,
    refs: () => [],
  },
  run(p, c) {
    const who = resolveWho(p.target, c);
    if (who === undefined) return { effects: [warn(`SetMoveRoute: 対象 "${p.target}" がマップに居ない`)] };
    const steps = routeSteps(who, p.route, p.route.repeat ? 1 : 0, false);
    // ターン制のルートは、プレイヤーの手を待つので、このインタプリタの中では実行できない（プレイヤーは通常のイベントの間は動けず、デッドロックする）。常に並列で動かす
    if (p.wait && !p.route.repeat && p.route.pace !== "playerStep") return steps.length === 0 ? {} : { control: { kind: "call", commands: steps } };

    const commands: EventCommand[] = p.route.repeat ? [{ code: "Loop", params: {}, indent: 0 }, ...steps, { code: "EndLoop", params: {}, indent: 0 }] : steps;
    const name = originName(who);
    const rest = { ...c.state, interpreters: c.state.interpreters.filter((i) => !(i.origin.kind === "plugin" && i.origin.name === name)) };
    return { state: startInterpreter(rest, { kind: "plugin", name }, commands, "parallel") } satisfies CommandResult;
  },
});
