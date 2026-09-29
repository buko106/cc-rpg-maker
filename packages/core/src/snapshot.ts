import { assetIdSchema, assetRefSchema, directionSchema, eventCommandSchema, eventIdSchema, err, mapIdSchema, nonNegativeInt, ok } from "@rpg/schema";
import type { Result, SchemaIssue } from "@rpg/schema";
import { z } from "zod";
import type { Ctx } from "./ctx.js";
import type { Character, EventRuntime, GameState } from "./state.js";

/** セーブデータのフォーマットバージョン。`SaveSnapshot` を変えるときは上げて `snapshotMigrations` を追加する。 */
export const SNAPSHOT_VERSION = 1 as const;

/** `GameState` から一時状態を除いた、JSON 化可能な表現。 */
export type SerializedGameState = Omit<GameState, "battle">;

export interface SaveSnapshot {
  version: number;
  projectId: string;
  /** 互換判定用（docs/11-save-store.md）。 */
  projectHash: string;
  /** ISO 8601。runtime が Clock から与える。 */
  savedAt: string;
  playtimeTicks: number;
  state: SerializedGameState;
  preview: { mapName: string; partyNames: string[]; level: number };
}

export type SnapshotError =
  | { kind: "invalid"; issues: SchemaIssue[] }
  | { kind: "newer-version"; found: number; supported: number }
  | { kind: "migration"; message: string }
  | { kind: "missing-map"; mapId: string };

export const snapshotMigrations: readonly SnapshotMigration[] = [];

const snapCharacter = <C extends Character>(ch: C): C => (ch.moving || ch.realX !== ch.x || ch.realY !== ch.y ? { ...ch, realX: ch.x, realY: ch.y, moving: false } : ch);

/**
 * セーブ時に捨てる一時状態を落とす：移動の補間中の位置（`realX/realY/moving`）を目的のタイルに確定させる。
 * `fromSnapshot(toSnapshot(s))` は `stripTransient(s)` と一致する。
 */
export function stripTransient(s: GameState): SerializedGameState {
  const { battle: _battle, ...rest } = s;
  const events: Record<string, EventRuntime> = {};
  for (const [id, ev] of Object.entries(s.map.events)) events[id] = snapCharacter(ev);
  return { ...rest, map: { ...s.map, player: snapCharacter(s.map.player), events, followers: s.map.followers.map(snapCharacter) } };
}

export function toSnapshot(s: GameState, meta: { projectId: string; projectHash: string; savedAt: string }): SaveSnapshot {
  const state = stripTransient(s);
  const first = state.party.members[0];
  return {
    version: SNAPSHOT_VERSION,
    projectId: meta.projectId,
    projectHash: meta.projectHash,
    savedAt: meta.savedAt,
    playtimeTicks: state.playtimeTicks,
    state: JSON.parse(JSON.stringify(state)) as SerializedGameState,
    preview: {
      mapName: state.map.name,
      partyNames: state.party.members.map((id) => state.actors[id]?.name ?? String(id)),
      level: first === undefined ? 0 : (state.actors[first]?.level ?? 0),
    },
  };
}

// ---- 検証スキーマ（破損したセーブデータを弾く） ----

const int = z.number().int();
const characterShape = {
  x: int,
  y: int,
  realX: z.number(),
  realY: z.number(),
  direction: directionSchema,
  moving: z.boolean(),
  speed: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  graphic: z.strictObject({ asset: assetIdSchema, index: nonNegativeInt }).optional(),
  through: z.boolean(),
};
const characterSchema = z.strictObject(characterShape);
const eventRuntimeSchema = z.strictObject({
  ...characterShape,
  id: eventIdSchema,
  pageIndex: nonNegativeInt.nullable(),
  trigger: z.enum(["action", "touch", "autorun", "parallel"]).nullable(),
  priority: z.enum(["below", "same", "above"]),
});

const waitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("frames"), left: nonNegativeInt }),
  z.strictObject({ kind: z.literal("message") }),
  z.strictObject({ kind: z.literal("choice") }),
  z.strictObject({ kind: z.literal("move"), who: z.string() }),
  z.strictObject({ kind: z.literal("battle") }),
  z.strictObject({ kind: z.literal("transfer") }),
  z.strictObject({ kind: z.literal("child"), id: z.string() }),
]);
const originSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mapEvent"), mapId: mapIdSchema, eventId: eventIdSchema, page: nonNegativeInt }),
  z.strictObject({ kind: z.literal("commonEvent"), id: z.string() }),
  z.strictObject({ kind: z.literal("troop"), troopId: z.string(), page: nonNegativeInt }),
  z.strictObject({ kind: z.literal("plugin"), name: z.string() }),
]);
const branchSchema = z.record(z.string().regex(/^\d+$/), z.number());
const commandsSchema = z.array(eventCommandSchema);
const interpreterSchema = z.strictObject({
  id: z.string(),
  origin: originSchema,
  mode: z.enum(["normal", "parallel"]),
  commands: commandsSchema,
  pc: nonNegativeInt,
  wait: waitSchema,
  branch: branchSchema,
  callStack: z.array(z.strictObject({ commands: commandsSchema, pc: nonNegativeInt, branch: branchSchema })),
  locals: z.record(z.string(), z.unknown()),
});

const serializedStateSchema = z.strictObject({
  tick: nonNegativeInt,
  rng: z.strictObject({
    seed: z.string(),
    s: z.tuple([z.number().int().min(0).max(0xffffffff), z.number().int().min(0).max(0xffffffff), z.number().int().min(0).max(0xffffffff), z.number().int().min(0).max(0xffffffff)]),
  }),
  scene: z.strictObject({ kind: z.enum(["title", "map", "battle", "menu", "gameover"]) }),
  map: z.strictObject({
    mapId: mapIdSchema,
    name: z.string(),
    player: characterSchema,
    events: z.record(z.string(), eventRuntimeSchema),
    followers: z.array(characterSchema),
    camera: z.strictObject({ x: z.number(), y: z.number() }),
    transfer: z
      .strictObject({ to: mapIdSchema, x: int, y: int, dir: directionSchema, fade: z.enum(["black", "white", "none"]), requested: z.boolean() })
      .optional(),
    encounterSteps: nonNegativeInt,
  }),
  party: z.strictObject({ gold: nonNegativeInt, members: z.array(z.string()), items: z.record(z.string(), nonNegativeInt) }),
  actors: z.record(z.string(), z.strictObject({ id: z.string(), name: z.string(), level: int, exp: nonNegativeInt, hp: int, mp: int })),
  switches: z.record(z.string(), z.boolean()),
  variables: z.record(z.string(), z.number()),
  selfSwitches: z.record(z.string(), z.boolean()),
  interpreters: z.array(interpreterSchema),
  nextInterpreterId: nonNegativeInt,
  message: z.strictObject({
    open: z.boolean(),
    owner: z.string(),
    text: z.string(),
    face: assetRefSchema.nullable(),
    position: z.enum(["top", "middle", "bottom"]),
    background: z.enum(["window", "dim", "transparent"]),
    choices: z.array(z.string()).nullable(),
  }),
  timers: z.strictObject({ active: z.boolean(), ticks: nonNegativeInt }),
  playtimeTicks: nonNegativeInt,
});

const snapshotSchema = z.strictObject({
  version: z.number().int().min(1),
  projectId: z.string(),
  projectHash: z.string(),
  savedAt: z.string(),
  playtimeTicks: nonNegativeInt,
  state: serializedStateSchema,
  preview: z.strictObject({ mapName: z.string(), partyNames: z.array(z.string()), level: z.number().int() }),
});

export type SnapshotMigration = { from: number; to: number; migrate(s: unknown): unknown };

/**
 * `snap` をバージョン `version` から `target` まで順次マイグレーションする。
 * @param registry テスト用に差し替え可能。既定は `snapshotMigrations`。
 */
export function migrateSnapshot(
  snap: unknown,
  version: number,
  target: number = SNAPSHOT_VERSION,
  registry: readonly SnapshotMigration[] = snapshotMigrations,
): Result<unknown, SnapshotError> {
  let current = snap;
  for (let v = version; v < target; v++) {
    const m = registry.find((x) => x.from === v);
    if (m === undefined) return err({ kind: "migration", message: `v${v} → v${v + 1} のマイグレーションが無い` });
    current = m.migrate(current);
  }
  return ok(current);
}

/**
 * セーブデータから GameState を復元する。古いバージョンは `snapshotMigrations` で順次変換する。
 * 構造が壊れている・新しすぎる・存在しないマップを指している場合は `Err`。例外は投げない。
 * 戻り値の状態は入力と別のオブジェクト（エイリアスしない）。
 */
export function fromSnapshot(snap: SaveSnapshot, ctx: Ctx): Result<GameState, SnapshotError> {
  const version = (snap as { version?: unknown } | null)?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return err({ kind: "invalid", issues: [{ path: "version", message: "1 以上の整数の version が必要" }] });
  }
  if (version > SNAPSHOT_VERSION) return err({ kind: "newer-version", found: version, supported: SNAPSHOT_VERSION });

  const migrated = migrateSnapshot(snap, version);
  if (!migrated.ok) return migrated;

  const parsed = snapshotSchema.safeParse(migrated.value);
  if (!parsed.success) {
    return err({ kind: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
  }
  const state = parsed.data.state as unknown as GameState;
  if (!Object.hasOwn(ctx.project.project.maps, state.map.mapId)) return err({ kind: "missing-map", mapId: state.map.mapId });
  return ok(state);
}
