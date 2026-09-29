import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyInput, initialState, inputFrame, step } from "@rpg/core";
import type { Button, Effect, GameState, InputFrame } from "@rpg/core";
import { FIXTURES_ROOT } from "../fixtures.js";
import { loadFixtureProject } from "./project.js";

/** `fixtures/replays/*.json` の入力列の1要素（docs/16-testing.md）。 */
export type ReplayInput =
  /** `button` を `frames` フレーム押し続ける（最初のフレームだけ「押下開始」）。 */
  | { hold: Button; frames: number }
  /** 1フレームだけ押す。 */
  | { press: Button }
  /** 何もせず `wait` フレーム進める。 */
  | { wait: number };

export interface ReplayFixture {
  /** 例 `fixtures/projects/v1/minimal` */
  project: string;
  seed: string;
  inputs: ReplayInput[];
  expect: {
    finalStateHash?: string;
    /** Effect の `kind` ごとの発行回数。 */
    effects?: Record<string, number>;
  };
  assertions?: { atTick: number; path: string; equals: unknown }[];
}

export function expandInputs(inputs: readonly ReplayInput[]): InputFrame[] {
  const frames: InputFrame[] = [];
  for (const input of inputs) {
    if ("hold" in input) {
      for (let i = 0; i < input.frames; i++) frames.push(inputFrame([input.hold], i === 0 ? [input.hold] : []));
    } else if ("press" in input) {
      frames.push(inputFrame([input.press], [input.press]));
    } else {
      for (let i = 0; i < input.wait; i++) frames.push(emptyInput());
    }
  }
  return frames;
}

/** キーをソートして JSON 化する。同じ内容のオブジェクトは常に同じ文字列になる。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** GameState の安定ソート JSON の sha256。 */
export function hashState(state: GameState): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}

/** `map.player.x` や `switches.sw_talked` のようなドット区切りのパスで値を取り出す。 */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export interface ReplayResult {
  state: GameState;
  frames: number;
  finalStateHash: string;
  effectCounts: Record<string, number>;
  effects: Effect[];
  /** 満たされなかった `assertions` の説明。 */
  assertionFailures: string[];
}

/** リプレイを core 上で実行する（runtime 無し）。プロジェクトは全マップをロード済みとして扱う。 */
export function runReplay(fixture: ReplayFixture): ReplayResult {
  const match = /projects\/v(\d+)\/([^/]+)\/?$/.exec(fixture.project);
  if (match === null) throw new Error(`replay: project のパスが不正: ${fixture.project}`);
  const { ctx } = loadFixtureProject(match[2]!, Number(match[1]));

  let state = initialState(ctx, fixture.seed);
  const effects: Effect[] = [];
  const effectCounts: Record<string, number> = {};
  const assertionFailures: string[] = [];
  const byTick = new Map<number, NonNullable<ReplayFixture["assertions"]>>();
  for (const a of fixture.assertions ?? []) byTick.set(a.atTick, [...(byTick.get(a.atTick) ?? []), a]);

  const frames = expandInputs(fixture.inputs);
  for (const input of frames) {
    const r = step(state, input, ctx);
    state = r.state;
    for (const e of r.effects) {
      effects.push(e);
      effectCounts[e.kind] = (effectCounts[e.kind] ?? 0) + 1;
    }
    for (const a of byTick.get(state.tick) ?? []) {
      const actual = getPath(state, a.path);
      if (stableStringify(actual) !== stableStringify(a.equals)) {
        assertionFailures.push(`tick ${a.atTick}: ${a.path} = ${stableStringify(actual)}（期待: ${stableStringify(a.equals)}）`);
      }
    }
  }
  const maxTick = Math.max(0, ...[...byTick.keys()]);
  if (maxTick > state.tick) assertionFailures.push(`assertions に最終 tick (${state.tick}) より後の atTick=${maxTick} がある`);

  return { state, frames: frames.length, finalStateHash: hashState(state), effectCounts, effects, assertionFailures };
}

const REPLAYS_DIR = join(FIXTURES_ROOT, "replays");

export function listReplays(): string[] {
  return readdirSync(REPLAYS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export function loadReplay(name: string): ReplayFixture {
  return JSON.parse(readFileSync(join(REPLAYS_DIR, `${name}.json`), "utf8")) as ReplayFixture;
}

/**
 * `UPDATE_REPLAYS=1` のときに、期待するハッシュをリプレイファイルに書き戻す。差分はレビューすること。
 * ファイルの体裁を保つため、`finalStateHash` の値だけを書き換える（無ければ `expect` の先頭に挿入する）。
 */
export function updateReplayHash(name: string, finalStateHash: string): void {
  const path = join(REPLAYS_DIR, `${name}.json`);
  const text = readFileSync(path, "utf8");
  const existing = /("finalStateHash"\s*:\s*)"[^"]*"/;
  const updated = existing.test(text)
    ? text.replace(existing, `$1"${finalStateHash}"`)
    : text.replace(/("expect"\s*:\s*\{)/, `$1 "finalStateHash": "${finalStateHash}",`);
  if (updated === text && !text.includes(finalStateHash)) throw new Error(`replay ${name}: expect が見つからない`);
  writeFileSync(path, updated);
}
