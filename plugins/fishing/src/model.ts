import { pluginStateOf, withPluginState, z } from "@rpg/plugin-api";
import type { GameState, JsonValue } from "@rpg/plugin-api";

/** `GameState.pluginState` で使うキー（プラグインの名前）。 */
export const STATE_KEY = "fishing";

const int = z.number().int();

/** 竿を振ってから、釣れる・逃げるまでの 1 回分（`wait` 待って、`bite` に決定ボタン、`reel` で巻き上げ、`done` で結果を見せる）。 */
export const castSchema = z.strictObject({
  phase: z.enum(["wait", "bite", "reel", "done"]),
  /** `wait` / `bite` / `done` のあいだ、残りのフレーム。 */
  left: int.min(0),
  /** この回が始まってからのフレーム（アニメーション用）。 */
  t: int.min(0),
  spot: z.string(),
  /** 使ったエサの名前（無ければ null）。 */
  bait: z.string().nullable(),
  /** 当たり判定の幅（バーの長さに対する割合）。 */
  zoneSize: z.number(),
  /** 手ごわい魚の出やすさ（エサの `rare`）。 */
  rare: z.number(),
  /** かかった魚（`bite` 以降）と、その大きさ（cm）。 */
  fish: z.string().nullable(),
  size: z.number(),
  /** 巻き上げ：魚の位置・動く先・当たり判定の中心・その速さ・巻き上げた量（すべて 0〜1）。 */
  pos: z.number(),
  target: z.number(),
  zone: z.number(),
  zoneVel: z.number(),
  progress: z.number(),
  result: z
    .strictObject({
      kind: z.enum(["caught", "lost", "missed", "early", "quit", "nothing"]),
      fish: z.string().nullable(),
      size: z.number(),
      points: int.min(0),
      /** その魚で、これまでの最大を超えた。 */
      record: z.boolean(),
      /** 初めて釣った種類。 */
      first: z.boolean(),
    })
    .nullable(),
});
export type CastState = z.infer<typeof castSchema>;
export type CastResult = NonNullable<CastState["result"]>;

const rankingSchema = z.strictObject({ name: z.string(), score: int.min(0), you: z.boolean() });

export const fishingSchema = z.strictObject({
  v: z.literal(1),
  /** 図鑑：魚の `key` → 釣った数と最大の大きさ（cm）。 */
  album: z.record(z.string(), z.strictObject({ count: int.min(1), best: z.number() })),
  /** 大会に出ている間だけ。 */
  tournament: z.strictObject({ score: int.min(0), catches: int.min(0), biggest: z.strictObject({ key: z.string(), size: z.number() }).nullable() }).nullable(),
  cast: castSchema.nullable(),
  /** 画面いっぱいに出す表示（図鑑・結果発表）。`wait: plugin` で、閉じるのを待つ。 */
  screen: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("album") }),
      z.strictObject({ kind: z.literal("result"), ranking: z.array(rankingSchema), rank: int.min(1), prize: int.min(0), trophy: z.boolean(), score: int.min(0), catches: int.min(0) }),
    ])
    .nullable(),
});
export type FishingState = z.infer<typeof fishingSchema>;
export type Screen = NonNullable<FishingState["screen"]>;

export const emptyFishing = (): FishingState => ({ v: 1, album: {}, tournament: null, cast: null, screen: null });

const cache = new WeakMap<object, FishingState | null>();

/** 状態から、釣りの状態を読む（まだ何も無い・壊れているときは `undefined`）。同じ値は何度読んでも検証し直さない。 */
export function readFishing(state: Pick<GameState, "pluginState">): FishingState | undefined {
  const raw = pluginStateOf(state, STATE_KEY);
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  const hit = cache.get(raw);
  if (hit !== undefined) return hit === null ? undefined : hit;
  const r = fishingSchema.safeParse(raw);
  const parsed = r.success ? r.data : null;
  cache.set(raw, parsed);
  return parsed === null ? undefined : parsed;
}

export const withFishing = <S extends Pick<GameState, "pluginState">>(state: S, fs: FishingState): S => withPluginState(state, STATE_KEY, fs as unknown as JsonValue);
