import { eventIdSchema, moveRouteSchema, moveStepSchema } from "@rpg/schema";
import type { Direction, EventCommand } from "@rpg/schema";
import { z } from "zod";
import { warn } from "../../effects.js";
import { moveCharacter } from "../../map/index.js";
import type { Character, GameState } from "../../state.js";
import { defineCommand } from "../handler.js";
import type { CommandCtx, CommandResult } from "../handler.js";
import { startInterpreter } from "../run.js";

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

/** 歩む方向：`toward` / `away` はプレイヤーとの位置関係で（大きい軸の側）、`random` は共有の乱数から決める。 */
function pickDirection(dir: Direction | "random" | "toward" | "away", who: string, ch: Character, c: CommandCtx): Direction {
  if (dir === "random") return (["down", "left", "right", "up"] as const)[c.rng.int(0, 3)]!;
  if (dir !== "toward" && dir !== "away") return dir;
  const p = c.state.map.player;
  const dx = p.x - ch.x;
  const dy = p.y - ch.y;
  if (who === "player" || (dx === 0 && dy === 0)) return ch.direction;
  const toward: Direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  return dir === "toward" ? toward : ({ up: "down", down: "up", left: "right", right: "left" } as const)[toward];
}

const stepParams = z.strictObject({ who: z.string(), step: moveStepSchema, skippable: z.boolean().default(false) });

/**
 * 内部用：移動ルートの 1 歩。`SetMoveRoute` がルートを展開して作る。
 * 歩みは前の移動が終わってから行い、歩いたらそれが終わるまで待つ。通れないときは（`skippable` なら）あきらめ、
 * そうでなければ通れるようになるのを待つ（`MAX_BLOCKED_FRAMES` を超えたらあきらめる）。
 * 動かす対象がマップに居なくなったら、ルートごと終了する。
 */
export const moveStep = defineCommand({
  code: "MoveStep",
  params: stepParams,
  meta: { label: "移動ルートの 1 歩", category: "移動", describe: (p) => `移動ルート：${p.step.kind}`, refs: () => [] },
  run(p, c) {
    const ch = characterOf(c.state, p.who);
    if (ch === undefined) return { control: { kind: "exit" } };
    if (ch.moving) return { control: { kind: "wait", wait: { kind: "frames", left: 1 } }, setLocals: { retry: true } };
    const step = p.step;
    switch (step.kind) {
      case "turn":
        return { state: withCharacter(c.state, p.who, { ...ch, direction: step.dir }) };
      case "speed":
        return { state: withCharacter(c.state, p.who, { ...ch, speed: step.value as Character["speed"] }) };
      case "wait":
        return step.frames === 0 ? {} : { control: { kind: "wait", wait: { kind: "frames", left: step.frames } }, setLocals: { retry: undefined } };
      case "move": {
        const map = c.project.map(c.state.map.mapId);
        if (map === undefined) return {};
        const dir = pickDirection(step.dir, p.who, ch, c);
        const moved = moveCharacter(ch, dir, { map, tileset: c.project.tileset(map.tileset) ?? { id: "" as never, name: "", passage: [] }, events: c.state.map.events });
        const blocked = moved.x === ch.x && moved.y === ch.y;
        const next = withCharacter(c.state, p.who, moved);
        if (!blocked) return { state: next, control: { kind: "wait", wait: { kind: "move", who: p.who } } };
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

const params = z.strictObject({ target: target.default("this"), route: moveRouteSchema, wait: z.boolean().default(false) });

const originName = (who: string): string => `moveRoute:${who}`;

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
    const steps: EventCommand[] = p.route.steps.map((step) => ({ code: "MoveStep", params: { who, step, skippable: p.route.skippable }, indent: p.route.repeat ? 1 : 0 }));
    if (p.wait && !p.route.repeat) return steps.length === 0 ? {} : { control: { kind: "call", commands: steps } };

    const commands: EventCommand[] = p.route.repeat ? [{ code: "Loop", params: {}, indent: 0 }, ...steps, { code: "EndLoop", params: {}, indent: 0 }] : steps;
    const name = originName(who);
    const rest = { ...c.state, interpreters: c.state.interpreters.filter((i) => !(i.origin.kind === "plugin" && i.origin.name === name)) };
    return { state: startInterpreter(rest, { kind: "plugin", name }, commands, "parallel") } satisfies CommandResult;
  },
});
