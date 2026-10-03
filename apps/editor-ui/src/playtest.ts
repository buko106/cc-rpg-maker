import { createRuntime } from "@rpg/runtime";
import type { AssetSource, AudioOut, InputSource, Logger, ProjectSource, Renderer, Runtime, RuntimeExtensions, Scheduler } from "@rpg/runtime";
import { canPass, newCharacter, selfSwitchKey, stateConditionHolds, toSnapshot } from "@rpg/core";
import type { GameState } from "@rpg/core";
import { createMemorySaveRepository } from "@rpg/save-store";
import type { DocProjectSource, EditorSession } from "@rpg/editor-core";
import type { ActorId, Direction, ItemId, MapData, MapEvent, MapId, Project, SwitchId, VariableId } from "@rpg/schema";

/** 開始時にゲームの状態へ上書きする値。 */
export interface StatePatch {
  switches?: Record<SwitchId, boolean>;
  variables?: Record<VariableId, number>;
  /** キーは `selfSwitchKey(mapId, eventId, "A")` の形。 */
  selfSwitches?: Record<string, boolean>;
  /** 所持数（既にそれ以上持っていれば変えない）。 */
  items?: Record<ItemId, number>;
  /** パーティに加えるアクター。 */
  members?: ActorId[];
}

/** 「選択イベントからテストプレイ」の開始位置と状態。省略するとタイトルから始める。 */
export interface PlaytestStart {
  mapId: MapId;
  x: number;
  y: number;
  /** プレイヤーの向き（省略 = 下）。 */
  direction?: Direction;
  /** 開始時の状態の上書き（ページの条件を満たすためなど）。 */
  state?: StatePatch;
}

const VECTOR: Readonly<Record<Direction, { dx: number; dy: number }>> = { up: { dx: 0, dy: -1 }, down: { dx: 0, dy: 1 }, left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 } };
/** イベントの下・左・右・上の順に、プレイヤーが立てる場所を探す（そこからイベントの向きは逆）。 */
const APPROACH: readonly { side: Direction; facing: Direction }[] = [
  { side: "down", facing: "up" },
  { side: "left", facing: "right" },
  { side: "right", facing: "left" },
  { side: "up", facing: "down" },
];

export interface EventStartPlan {
  start: PlaytestStart;
  /** ページ条件を満たしても、後ろのページが優先されてこのページが有効にならないとき、その後ろのページの番号（0 始まり）。 */
  shadowedBy?: number;
}

/**
 * 「このイベントのこのページを、いま動かせる状態で始める」計画を立てる。
 * - ページの条件（スイッチ・変数・セルフスイッチ・所持品・アクター）を満たす状態の上書きを作る。
 * - プレイヤーは、イベントの隣（通れるところ）でイベントの方を向いて立つ。隣に立てなければイベントの上。
 */
export function planEventStart(project: Project, map: MapData, event: MapEvent, pageIndex: number): EventStartPlan {
  const page = event.pages[pageIndex];
  const patch: StatePatch = {};
  for (const c of page?.conditions ?? []) {
    switch (c.kind) {
      case "switch":
        (patch.switches ??= {})[c.id] = c.value;
        break;
      case "variable":
        (patch.variables ??= {})[c.id] = c.value;
        break;
      case "selfSwitch":
        (patch.selfSwitches ??= {})[selfSwitchKey(map.id, event.id, c.key)] = c.value;
        break;
      case "item":
        (patch.items ??= {})[c.id] = 1;
        break;
      case "actor":
        (patch.members ??= []).push(c.id);
        break;
    }
  }

  const tileset = project.tilesets[map.tileset];
  const occupied = new Set(Object.values(map.events).filter((e) => e.id !== event.id).map((e) => `${e.x},${e.y}`));
  let at: { x: number; y: number; direction: Direction } = { x: event.x, y: event.y, direction: "down" };
  if (tileset !== undefined) {
    for (const { side, facing } of APPROACH) {
      const x = event.x + VECTOR[side].dx;
      const y = event.y + VECTOR[side].dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height || occupied.has(`${x},${y}`)) continue;
      if (canPass(map, tileset, {}, newCharacter(x, y, facing), facing)) {
        at = { x, y, direction: facing };
        break;
      }
    }
  }

  const plan: EventStartPlan = { start: { mapId: map.id, ...at, ...(Object.keys(patch).length === 0 ? {} : { state: patch }) } };
  // 後ろのページが優先されるので、その条件も（上書き後の状態で）満たしてしまうなら知らせる
  // `stateConditionHolds` が見るのは、スイッチ・変数・所持品・パーティだけ
  const probe = patchedState(emptyState(), patch);
  for (let i = event.pages.length - 1; i > pageIndex; i--) {
    const later = event.pages[i]!;
    const holdsAll = later.conditions.every((c) => (c.kind === "selfSwitch" ? probe.selfSwitches[selfSwitchKey(map.id, event.id, c.key)] === c.value : stateConditionHolds(c, probe as GameState)));
    if (holdsAll) {
      plan.shadowedBy = i;
      break;
    }
  }
  return plan;
}

/** 条件の判定にだけ使う、空の状態（スイッチ・変数・所持品・パーティだけ見る）。 */
function emptyState(): Pick<GameState, "switches" | "variables" | "selfSwitches" | "party"> {
  return { switches: {}, variables: {}, selfSwitches: {}, party: { gold: 0, members: [], items: {} } };
}

/** `patch` を `state` に重ねた新しい状態。 */
function patchedState<S extends Pick<GameState, "switches" | "variables" | "selfSwitches" | "party">>(state: S, patch: StatePatch): S {
  const items = { ...state.party.items };
  for (const [id, n] of Object.entries(patch.items ?? {})) items[id as ItemId] = Math.max(items[id as ItemId] ?? 0, n);
  const members = [...state.party.members];
  for (const id of patch.members ?? []) if (!members.includes(id)) members.push(id);
  return {
    ...state,
    switches: { ...state.switches, ...patch.switches },
    variables: { ...state.variables, ...patch.variables },
    selfSwitches: { ...state.selfSwitches, ...patch.selfSwitches },
    party: { ...state.party, items, members },
  };
}

export interface Playtest {
  readonly runtime: Runtime;
  /** ループを止め、入力・音を解放する。 */
  stop(): void;
}

export interface PlaytestDeps {
  scheduler: Scheduler;
  renderer: Renderer;
  audio: AudioOut;
  input: InputSource & { dispose?(): void };
  assets: AssetSource;
  logger?: Logger;
  onError?: (error: unknown) => void;
  /** 乱数の種。省略すると開始時刻。 */
  seed?: string;
  /** プロジェクトが有効にしているプラグイン。 */
  extensions?: RuntimeExtensions;
}

/**
 * 編集中の文書でゲームを起動する（docs/13-editor-ui.md「テストプレイ」）。
 * - セーブはメモリ上に置くので、本番のセーブデータには触れない。
 * - `start` があれば、開始マップ・位置をその場所に差し替えて、タイトルを飛ばしてすぐ始める。
 */
export async function startPlaytest(session: EditorSession, deps: PlaytestDeps, start?: PlaytestStart): Promise<Playtest> {
  const base: DocProjectSource = session.projectSource();
  const source: ProjectSource =
    start === undefined
      ? base
      : {
          ...base,
          project: async () => {
            const project = await base.project();
            return { ...project, system: { ...project.system, startMap: start.mapId, startX: start.x, startY: start.y } };
          },
        };
  const project = await source.project();
  const runtime = createRuntime({
    scheduler: deps.scheduler,
    renderer: deps.renderer,
    audio: deps.audio,
    input: deps.input,
    assets: deps.assets,
    projectSource: source,
    saves: createMemorySaveRepository({ projectId: project.meta.id, projectHash: await source.projectHash() }),
    title: start === undefined,
    clock: Date.now,
    ...(deps.seed === undefined ? {} : { seed: deps.seed }),
    ...(deps.extensions === undefined ? {} : { extensions: deps.extensions }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
  });
  await runtime.start();
  if (start?.state !== undefined || start?.direction !== undefined) {
    // 開始時の状態を上書きして、セーブを読み込む形で反映する（ページは次の tick で更新される）
    const state = patchedState(runtime.getState(), start.state ?? {});
    const player = start.direction === undefined ? state.map.player : { ...state.map.player, direction: start.direction };
    const snapshot = toSnapshot({ ...state, map: { ...state.map, player } }, { projectId: project.meta.id, projectHash: await source.projectHash(), savedAt: new Date().toISOString() });
    runtime.dispatch({ type: "loadSnapshot", snapshot });
  }
  return {
    runtime,
    stop() {
      runtime.stop();
      deps.input.dispose?.();
      deps.audio.dispose?.();
    },
  };
}
