import { defineCommand, getVar, setVar, warn, z } from "@rpg/plugin-api";
import type { CommandCtx, CommandResult, GameState, PluginCommand } from "@rpg/plugin-api";
import type { Config } from "./config.js";
import { pickGear, pointsOf, rank, rivalScore, startCast, stepCast } from "./fish.js";
import type { CastStep } from "./fish.js";
import { emptyFishing, readFishing, withFishing } from "./model.js";
import type { CastState, FishingState } from "./model.js";

export type ConfigResult = { ok: true; config: Config } | { ok: false; message: string };

/** プレイヤー自身の、順位表での名前。 */
export const PLAYER_NAME = "あなた";

const WAIT = { kind: "wait", wait: { kind: "plugin", name: "fishing" } } as const;
type Items = GameState["party"]["items"];
const addItem = (s: GameState, item: string, n: number): GameState => {
  const items: Record<string, number> = { ...s.party.items };
  const count = (items[item] ?? 0) + n;
  if (count > 0) items[item] = count;
  else delete items[item];
  return { ...s, party: { ...s.party, items: items as Items } };
};

const none = (message: string): CommandResult => ({ effects: [warn(message)] });
const meta = (label: string, describe: string) => ({ label, category: "釣り", describe: () => describe, refs: () => [] });

/** 巻き上げが終わったときの反映：釣れたら持ち物・図鑑・大会の点数に入れる。やめたときはエサを返す。 */
export function applyOutcome(s: GameState, fs: FishingState, cast: CastState, outcome: NonNullable<CastStep["outcome"]>, cfg: Config): { state: GameState; fishing: FishingState; cast: CastState } {
  if (outcome.kind === "quit") {
    const bait = cfg.baits.find((b) => b.name === cast.bait);
    return { state: bait === undefined ? s : addItem(s, bait.item, 1), fishing: fs, cast };
  }
  if (outcome.kind !== "caught") return { state: s, fishing: fs, cast };
  const { fish, size } = outcome;
  const prev = fs.album[fish.key];
  const points = pointsOf(fish, size);
  const album = { ...fs.album, [fish.key]: { count: (prev?.count ?? 0) + 1, best: Math.max(prev?.best ?? 0, size) } };
  const t = fs.tournament;
  const biggest = t === null ? null : t.biggest !== null && t.biggest.size >= size ? t.biggest : { key: fish.key, size };
  const tournament = t === null ? null : { score: t.score + points, catches: t.catches + 1, biggest };
  let next = addItem(s, fish.item, 1);
  next = setVar(next, cfg.vars.species, Object.keys(album).length);
  return {
    state: next,
    fishing: { ...fs, album, tournament },
    cast: { ...cast, result: { kind: "caught", fish: fish.key, size, points: t === null ? 0 : points, record: prev === undefined || size > prev.best, first: prev === undefined } },
  };
}

export function createCommands(config: () => ConfigResult): PluginCommand<any>[] {
  const withConfig = (f: (cfg: Config) => CommandResult): CommandResult => {
    const r = config();
    return r.ok ? f(r.config) : none(r.message);
  };

  const cast = defineCommand({
    code: "Cast",
    params: z.strictObject({ spot: z.string().min(1).meta({ title: "釣り場の種類", initial: "pier" }) }),
    meta: { ...meta("釣る", "竿を振る（魚がかかったら巻き上げる。終わるまで待つ）"), describe: (p) => `釣る：${p.spot}` },
    run: (p, c) =>
      withConfig((cfg) => {
        const fs = readFishing(c.state) ?? emptyFishing();
        // 大会の制限時間が来ていたら、釣れない（進行役のイベントが終わらせる）
        if (fs.tournament !== null && !c.state.timers.active) return {};
        const gear = pickGear(cfg, c.state.party.items);
        const started = startCast(p.spot, gear.zone, gear.bait, c.rng);
        const s = gear.bait === undefined ? c.state : addItem(c.state, gear.bait.item, -1);
        return { state: withFishing(s, { ...fs, cast: started }), control: WAIT };
      }),
    resume: (_p, c) =>
      withConfig((cfg) => {
        const fs = readFishing(c.state);
        if (fs === undefined || fs.cast === null) return { control: { kind: "next" } };
        const input = { ok: c.input.pressed.has("ok"), okTriggered: c.input.triggered.has("ok"), cancel: c.input.triggered.has("cancel") };
        const step = stepCast(fs.cast, input, cfg, c.rng);
        if (step.end === true) return { state: withFishing(c.state, { ...fs, cast: null }), control: { kind: "next" } };
        let state = c.state;
        let fishing = fs;
        let current = step.cast;
        if (step.outcome !== undefined) {
          const applied = applyOutcome(state, fishing, current, step.outcome, cfg);
          state = applied.state;
          fishing = applied.fishing;
          current = applied.cast;
        }
        return { state: withFishing(state, { ...fishing, cast: current }), control: WAIT };
      }),
  });

  const start = defineCommand({
    code: "Start",
    params: z.strictObject({}),
    meta: meta("大会を始める", "釣り大会を始める（点数を 0 にして、制限時間のタイマーを動かす）"),
    run: (_p, c) =>
      withConfig((cfg) => {
        const fs = readFishing(c.state) ?? emptyFishing();
        let s = withFishing(c.state, { ...fs, tournament: { score: 0, catches: 0, biggest: null } });
        s = setVar(s, cfg.vars.event, 0);
        return { state: { ...s, timers: { active: true, ticks: cfg.tournament.seconds * 60 } } };
      }),
  });

  const watch = defineCommand({
    code: "Watch",
    params: z.strictObject({}),
    meta: meta("大会の見張り", "制限時間が来たら、イベント用の変数を 1 にする（大会の進行役の並列イベントに置く）"),
    run: (_p, c) =>
      withConfig((cfg) => {
        const s = c.state;
        const fs = readFishing(s);
        if (fs === undefined || fs.tournament === null || s.timers.active || s.scene.kind !== "map") return {};
        if (s.message.open || s.interpreters.some((i) => i.mode === "normal") || getVar(s, cfg.vars.event) !== 0) return {};
        return { state: setVar(s, cfg.vars.event, 1) };
      }),
  });

  const result = defineCommand({
    code: "Result",
    params: z.strictObject({}),
    meta: meta("結果発表", "大会を終えて、順位を発表する（賞金・トロフィーを渡して、変数に順位と点数を残す）"),
    run: (_p, c) =>
      withConfig((cfg) => {
        const fs = readFishing(c.state);
        if (fs === undefined || fs.tournament === null) return {};
        const t = fs.tournament;
        const rivals = cfg.tournament.rivals.map((r) => ({ name: r.name, score: rivalScore(r.skill, c.rng) }));
        const { standings, rank: place } = rank({ name: PLAYER_NAME, score: t.score }, rivals);
        const prize = cfg.tournament.prizes[place - 1] ?? 0;
        const trophy = place === 1 && cfg.tournament.trophy !== undefined;
        let s: GameState = { ...c.state, party: { ...c.state.party, gold: c.state.party.gold + prize }, timers: { active: false, ticks: 0 } };
        if (trophy && cfg.tournament.trophy !== undefined) s = addItem(s, cfg.tournament.trophy, 1);
        s = setVar(setVar(setVar(s, cfg.vars.rank, place), cfg.vars.score, t.score), cfg.vars.event, 0);
        if (place === 1) s = setVar(s, cfg.vars.wins, getVar(s, cfg.vars.wins) + 1);
        const screen = { kind: "result" as const, ranking: standings, rank: place, prize, trophy, score: t.score, catches: t.catches };
        return { state: withFishing(s, { ...fs, tournament: null, screen }), control: WAIT };
      }),
    resume: (_p, c) => closeScreen(c),
  });

  const album = defineCommand({
    code: "Album",
    params: z.strictObject({}),
    meta: meta("つり手帳を開く", "釣った魚の一覧（図鑑）を開く。決定・キャンセルで閉じる"),
    run: (_p, c) => ({ state: withFishing(c.state, { ...(readFishing(c.state) ?? emptyFishing()), screen: { kind: "album" } }), control: WAIT }),
    resume: (_p, c) => closeScreen(c),
  });

  return [cast, start, watch, result, album];
}

/** 画面を出している間は待ち、決定・キャンセルで閉じる。 */
function closeScreen(c: CommandCtx): CommandResult {
  const fs = readFishing(c.state);
  if (fs === undefined || fs.screen === null) return { control: { kind: "next" } };
  if (!c.input.triggered.has("ok") && !c.input.triggered.has("cancel")) return { control: WAIT };
  return { state: withFishing(c.state, { ...fs, screen: null }), control: { kind: "next" } };
}
