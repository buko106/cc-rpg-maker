/**
 * 難易度調整の bot を端末から使う（`pnpm bot`。docs/20-bot.md）。`tools/bot.mjs` が esbuild でまとめて動かす（Node 専用。`index.ts` からは出さない）。
 *
 *   pnpm bot <プロジェクトのフォルダ | fixtures の名前> --troop <ID|all> [--levels 3-8] [--runs 30] [--policy smart] [--seed bot] [--items potion:3] [--equip actor_hero:wp_iron] [--json]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { POLICIES } from "./policies.js";
import { formatLevelTable, levelSweep } from "./simulate.js";
import type { LevelRow } from "./simulate.js";
import { createCtx, createProjectView, initialState } from "@rpg/core";
import type { Ctx } from "@rpg/core";
import { parseMapData, parseProject } from "@rpg/schema";
import type { MapData, MapId } from "@rpg/schema";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures/projects/v1");

/** フォルダ形式のプロジェクト（`project.json` と `maps/`）を読む。名前だけなら `fixtures/projects/v1/<名前>`。 */
export function loadProjectDir(target: string): Ctx {
  const dir = existsSync(join(target, "project.json")) ? resolve(target) : join(FIXTURES, target);
  if (!existsSync(join(dir, "project.json"))) throw new Error(`${target}: project.json が見つからない`);
  const project = parseProject(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")));
  if (!project.ok) throw new Error(`${dir}/project.json が不正: ${JSON.stringify(project.error)}`);
  const maps: Record<MapId, MapData> = {};
  for (const file of readdirSync(join(dir, "maps")).filter((f) => f.endsWith(".json")).sort()) {
    const map = parseMapData(JSON.parse(readFileSync(join(dir, "maps", file), "utf8")), project.value.formatVersion);
    if (!map.ok) throw new Error(`${dir}/maps/${file} が不正: ${JSON.stringify(map.error)}`);
    maps[map.value.id] = map.value;
  }
  return createCtx(createProjectView(project.value, maps));
}

/** `3-8` → [3..8]、`1,5,9` → [1,5,9]。 */
export function parseLevels(spec: string): number[] {
  const levels = spec.split(",").flatMap((part) => {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (range !== null) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      return Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => (from <= to ? from + i : from - i));
    }
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1) throw new Error(`--levels: ${part} はレベルではない`);
    return [n];
  });
  return [...new Set(levels)];
}

/** `potion:3,ether:1` → { potion: 3, ether: 1 }。 */
export function parseItems(spec: string): Record<string, number> {
  return Object.fromEntries(
    spec.split(",").map((pair) => {
      const [id, n] = pair.split(":");
      const count = Number(n);
      if (id === undefined || id.trim() === "" || !Number.isInteger(count) || count < 0) throw new Error(`--items: ${pair} は「ID:個数」ではない`);
      return [id.trim(), count];
    }),
  );
}

/** `actor_hero:wp_iron,actor_mina:wp_rod` → { actor_hero: ["wp_iron"], actor_mina: ["wp_rod"] }。 */
export function parseEquips(spec: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of spec.split(",")) {
    const [actor, item] = pair.split(":").map((x) => x.trim());
    if (actor === undefined || item === undefined || actor === "" || item === "") throw new Error(`--equip: ${pair} は「アクターID:アイテムID」ではない`);
    (out[actor] ??= []).push(item);
  }
  return out;
}

/** 引数を読んで試行し、出力する文字列を返す。 */
export function runBotCli(argv: readonly string[]): string {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      troop: { type: "string" },
      levels: { type: "string" },
      runs: { type: "string", default: "30" },
      policy: { type: "string", default: "smart" },
      seed: { type: "string", default: "bot" },
      items: { type: "string" },
      equip: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const [target] = positionals;
  if (target === undefined || values.troop === undefined) throw new Error("使い方: pnpm bot <プロジェクト> --troop <ID|all> [--levels 3-8] [--runs 30] [--policy smart|attack|guard] [--seed bot] [--items potion:3] [--equip actor_hero:wp_iron] [--json]");
  const ctx = loadProjectDir(target);
  const policy = POLICIES[values.policy];
  if (policy === undefined) throw new Error(`--policy: ${values.policy} は無い（${Object.keys(POLICIES).join(" / ")}）`);
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs: ${values.runs} は 1 以上の整数ではない`);
  const troops = values.troop === "all" ? Object.keys(ctx.project.project.database.troops) : values.troop.split(",");
  const state = initialState(ctx, values.seed);
  const levels = values.levels === undefined ? [Math.max(1, ...state.party.members.map((id) => state.actors[id]?.level ?? 1))] : parseLevels(values.levels);
  const party = {
    ...(values.items === undefined ? {} : { items: parseItems(values.items) }),
    ...(values.equip === undefined ? {} : { equips: parseEquips(values.equip) }),
  };
  const results: { troop: string; name: string; rows: LevelRow[] }[] = troops.map((troop) => ({
    troop,
    name: ctx.project.troop(troop as never)?.name ?? troop,
    rows: levelSweep(state, ctx, levels, { troop, runs, policy, seed: values.seed, party }),
  }));
  if (values.json) return JSON.stringify(results.map(({ troop, rows }) => ({ troop, levels: rows.map((r) => ({ level: r.level, ...r.report })) })), null, 2);
  const members = state.party.members.map((id) => ctx.project.actor(id)?.name ?? id).join("・");
  return results.map(({ troop, name, rows }) => `■ ${name}（${troop}）  パーティ：${members}  作戦：${values.policy}  各 ${runs} 回\n${formatLevelTable(rows)}`).join("\n\n");
}
