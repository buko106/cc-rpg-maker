import { describe, expect, it } from "vitest";
import { drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { MapData } from "@rpg/schema";

// 謎解きの館のデモ（fixtures/projects/v1/mansion。tools/make-mansion-demo.mjs が生成する）の約束ごと
const { project, maps, ctx } = loadFixtureProject("mansion");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";
/** 選択肢・アイテム選択・数値入力への答え：選択肢の番号、選択肢の文字列、数値入力の値。 */
type Answer = number | string | { number: number };

const ROOM = { hall: "map_hall", study: "map_study", dining: "map_dining", bedroom: "map_bedroom" } as const;
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const passage = Object.values(project.tilesets)[0]!.passage;
const STEPS: [Dir, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];

function blocked(s: State, map: MapData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  const tile = map.layers.some((l) => {
    const t = l.tiles[y * map.width + x] ?? 0;
    return t !== 0 && passage[t] === 0;
  });
  return tile || Object.values(s.map.events).some((ev) => ev.x === x && ev.y === y && ev.pageIndex !== null && !ev.through && ev.priority === "same");
}

function route(s: State, tx: number, ty: number): Dir[] | undefined {
  const map = mapOf(s.map.mapId);
  const touch = new Set(Object.values(s.map.events).filter((ev) => ev.trigger === "touch").map((ev) => `${ev.x},${ev.y}`));
  const { x, y } = s.map.player;
  const prev = new Map<string, [string, Dir] | null>([[`${x},${y}`, null]]);
  const queue: [number, number][] = [[x, y]];
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [d, dx, dy] of STEPS) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = `${nx},${ny}`;
      if (prev.has(k) || blocked(s, map, nx, ny)) continue;
      if (touch.has(k) && !(nx === tx && ny === ty)) continue;
      prev.set(k, [`${cx},${cy}`, d]);
      queue.push([nx, ny]);
    }
  }
  if (!prev.has(`${tx},${ty}`)) return undefined;
  const dirs: Dir[] = [];
  for (let k = `${tx},${ty}`, p = prev.get(k); p != null; k = p[0], p = prev.get(k)) dirs.unshift(p[1]);
  return dirs;
}

const busy = (s: State): boolean => s.map.player.moving || s.map.transfer !== undefined || s.interpreters.length > 0 || s.message.open || s.scene.kind !== "map";

/** 進めている間に出たメッセージ（選択肢の見出しを含む）。 */
let seen: string[] = [];

/** イベントの処理が終わるまで進める。メッセージは決定で送り、選択肢・数値入力には `answers` の順に答える。 */
function settle(state: State, answers: Answer[] = []): State {
  let s = state;
  for (let i = 0; i < 400 && busy(s); i++) {
    if (s.scene.kind === "title") return s;
    if (s.message.open) {
      s = drive(s, ctx, idleFrames(2)).state;
      if (s.message.text !== "") seen.push(s.message.text);
      const m = s.message;
      if (m.numberInput !== undefined) {
        const want = answers.shift();
        if (typeof want !== "object") throw new Error(`数値入力に答えが無い（${String(want)}）`);
        // 前に入れた番号から始まるので、桁ごとに目当ての数字まで上げる（9 の次は 0）
        const digits = String(want.number).padStart(m.numberInput.digits, "0");
        const from = String(m.numberInput.value).padStart(m.numberInput.digits, "0");
        [...digits].forEach((d, i) => {
          const ups = (Number(d) - Number(from[i]) + 10) % 10;
          s = drive(s, ctx, [...Array.from({ length: ups }, () => [press("up"), ...idleFrames(1)]).flat(), press("right"), ...idleFrames(1)]).state;
        });
        expect(s.message.numberInput?.value).toBe(want.number);
      } else if (m.choices !== null) {
        const want = answers.shift() ?? 0;
        const index = typeof want === "string" ? m.choices.indexOf(want) : (want as number);
        if (index < 0) throw new Error(`選択肢 ${m.choices.join(" / ")} に ${String(want)} が無い`);
        while ((s.message.cursor ?? 0) !== index) s = drive(s, ctx, [press("down"), ...idleFrames(1)]).state;
      }
      s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
    } else s = driveUntil(s, ctx, (x) => !busy(x) || x.message.open || x.scene.kind !== "map", 600);
  }
  return drive(s, ctx, idleFrames(2)).state;
}

function walk(state: State, dirs: readonly Dir[]): State {
  let s = state;
  for (const d of dirs) s = settle(drive(s, ctx, [press(d)]).state);
  return s;
}

const at = (s: State, id: string) => {
  const ev = mapOf(s.map.mapId).events[id as keyof MapData["events"]];
  if (ev === undefined) throw new Error(`${s.map.mapId} に ${id} が無い`);
  return ev;
};

/** イベント `id` の隣まで歩き、そちらを向いて話しかける。 */
function talk(state: State, id: string, answers: Answer[] = []): State {
  let s = state;
  const { x, y } = at(s, id);
  const spot = STEPS.map(([d, dx, dy]) => ({ d, r: route(s, x - dx, y - dy) }))
    .filter((p): p is { d: Dir; r: Dir[] } => p.r !== undefined)
    .sort((a, b) => a.r.length - b.r.length)[0];
  if (spot === undefined) throw new Error(`${s.map.mapId} の ${id} に話しかけられる場所が無い`);
  s = walk(s, spot.r);
  s = drive(s, ctx, [press(spot.d), ...idleFrames(2)]).state;
  seen = [];
  return settle(drive(s, ctx, [press("ok"), ...idleFrames(1)]).state, answers);
}

/** 出入口のイベント `id` まで歩いて、別の部屋へ移る。 */
function go(state: State, id: string): State {
  const { x, y } = at(state, id);
  const r = route(state, x, y);
  if (r === undefined) throw new Error(`${state.map.mapId} で ${id} へ行けない`);
  return walk(state, r);
}

/** ニューゲームから、はじめの場面（自動実行）が終わるまで。 */
const newGame = (): State => {
  const s = runReplay({ project: "fixtures/projects/v1/mansion", seed: "mansion", inputs: [], expect: {} }).state;
  return settle(driveUntil(s, ctx, busy, 60));
};
const variable = (s: State, id: string): number => s.variables[id as keyof State["variables"]] ?? 0;
const has = (s: State, item: string): boolean => (s.party.items[item as keyof State["party"]["items"]] ?? 0) > 0;
const lit = (s: State): string[] => Object.values(s.map.events).filter((ev) => ev.id.startsWith("ev_candle_") && ev.pageIndex === 1).map((ev) => ev.id).sort();
const said = (): string => seen.join("\n");

describe("謎解きの館のデモ（fixtures/projects/v1/mansion）", () => {
  it("4 つの部屋はどれも 13×10 で、画面（416×320）にちょうど収まる。戦闘は無い", () => {
    expect(Object.keys(maps).sort()).toEqual(Object.values(ROOM).sort());
    for (const map of Object.values(maps)) expect([map.width, map.height]).toEqual([13, 10]);
    expect(project.system.screen).toEqual({ width: 13 * 32, height: 10 * 32 });
    expect(Object.keys(project.database.troops)).toEqual([]);
  });

  it("出入口の行き先は、行き先の部屋の通れるタイルで、戻る出入口の隣。場所移動は暗転する", () => {
    for (const map of Object.values(maps)) {
      for (const ev of Object.values(map.events)) {
        for (const p of ev.pages) {
          const t = p.commands.find((c) => c.code === "TransferPlayer")?.params as { mapId: string; x: number; y: number; fade: string } | undefined;
          if (t === undefined) continue;
          expect(t.fade, `${map.id} の ${ev.id}`).toBe("black");
          const dest = mapOf(t.mapId);
          for (const l of dest.layers) {
            const tile = l.tiles[t.y * dest.width + t.x] ?? 0;
            expect(tile === 0 || passage[tile] !== 0, `${map.id} の ${ev.id} → ${t.mapId} (${t.x}, ${t.y})`).toBe(true);
          }
          // 着いた場所の隣に、元の部屋へ戻る出入口がある
          const back = Object.values(dest.events).filter((e) => e.pages.some((q) => q.commands.some((c) => c.code === "TransferPlayer" && (c.params as { mapId: string }).mapId === map.id)));
          expect(back.some((e) => Math.abs(e.x - t.x) + Math.abs(e.y - t.y) === 1), `${t.mapId} に ${map.id} へ戻る出入口が無い`).toBe(true);
        }
      }
    }
  });

  it("はじめに閉じこめられ、招待状だけを持っている。なぞなぞに正解するまで甲冑が書斎の入口をふさぐ", () => {
    let s = newGame();
    expect(s.map.mapId).toBe(ROOM.hall);
    expect(has(s, "key_letter")).toBe(true);
    expect(route(s, at(s, "ev_to_study").x, at(s, "ev_to_study").y)).toBeUndefined();
    // 間違えると、ふさいだまま
    s = talk(s, "ev_armor", ["犬"]);
    expect(said()).toContain("出直して");
    expect(route(s, at(s, "ev_to_study").x, at(s, "ev_to_study").y)).toBeUndefined();
    s = talk(s, "ev_armor", ["人間"]);
    expect(said()).toContain("見事");
    expect(variable(s, "var_stage")).toBe(1);
    s = go(s, "ev_to_study");
    expect(s.map.mapId).toBe(ROOM.study);
  });

  it("ろうそくは順番を間違えると全部消え、白 → 赤 → 緑 → 青で灯すと食器棚が開く", () => {
    let s = go(newGame(), "ev_to_dining");
    expect(s.map.mapId).toBe(ROOM.dining);
    s = talk(s, "ev_candle_white");
    expect(lit(s)).toEqual(["ev_candle_white"]);
    s = talk(s, "ev_candle_green");
    expect(said()).toContain("消えてしまった");
    expect(lit(s)).toEqual([]);
    expect(variable(s, "var_candle")).toBe(0);
    s = talk(s, "ev_cupboard");
    expect(has(s, "key_bedroom")).toBe(false);
    for (const c of ["white", "red", "green", "blue"]) s = talk(s, `ev_candle_${c}`);
    expect(lit(s)).toHaveLength(4);
    s = talk(s, "ev_cupboard");
    expect(has(s, "key_bedroom")).toBe(true);
    // 二度目は空
    s = talk(s, "ev_cupboard");
    expect(s.party.items["key_bedroom" as keyof State["party"]["items"]]).toBe(1);
  });

  it("寝室の鍵を持つまで寝室の扉は開かず、持つと通れる", () => {
    let s = newGame();
    s = talk(s, "ev_bedroom_door");
    expect(said()).toContain("かぎが かかっている");
    expect(route(s, 6, 1)).toBeUndefined();
    s = go(s, "ev_to_dining");
    for (const c of ["white", "red", "green", "blue"]) s = talk(s, `ev_candle_${c}`);
    s = talk(s, "ev_cupboard");
    s = go(s, "ev_to_hall");
    s = go(s, "ev_bedroom_door");
    expect(s.map.mapId).toBe(ROOM.bedroom);
  });

  it("通しプレイ：なぞなぞ → メモ → ろうそく → 寝室の日記 → 柱時計 → 金庫（番号違いは開かない）→ 玄関（違う鍵は合わない）で脱出", () => {
    let s = newGame();
    s = talk(s, "ev_letter");
    expect(said()).toContain("金庫");
    s = talk(s, "ev_armor", ["人間"]);
    s = go(s, "ev_to_study");
    s = talk(s, "ev_memo");
    expect(said()).toContain("白 → 赤 → 緑 → 青");
    s = go(s, "ev_to_hall");
    s = go(s, "ev_to_dining");
    for (const c of ["white", "red", "green", "blue"]) s = talk(s, `ev_candle_${c}`);
    s = talk(s, "ev_cupboard");
    s = go(s, "ev_to_hall");
    s = go(s, "ev_bedroom_door");
    s = talk(s, "ev_diary");
    expect(said()).toContain("あの 時刻");
    expect(variable(s, "var_stage")).toBe(4);
    s = go(s, "ev_to_hall");
    s = go(s, "ev_to_dining");
    s = talk(s, "ev_clock");
    expect(said()).toContain("10時47分");
    s = go(s, "ev_to_hall");
    s = go(s, "ev_to_study");
    s = talk(s, "ev_safe", [{ number: 1234 }]);
    expect(said()).toContain("番号が ちがう");
    expect(has(s, "key_front")).toBe(false);
    s = talk(s, "ev_safe", [{ number: 1047 }]);
    expect(has(s, "key_front")).toBe(true);
    expect(variable(s, "var_stage")).toBe(5);
    s = go(s, "ev_to_hall");
    // 大事なものの一覧から選ぶ。招待状では開かない
    s = talk(s, "ev_front_door", ["招待状"]);
    expect(said()).toContain("合わない");
    expect(s.scene.kind).toBe("map");
    s = talk(s, "ev_front_door", ["玄関の鍵"]);
    s = driveUntil(s, ctx, (x) => x.scene.kind === "title", 600);
    expect(said()).toContain("脱出した");
    expect(s.scene.kind).toBe("title");
  });

  it("ネコは進み具合に応じて次の手がかりをくれる", () => {
    let s = newGame();
    s = talk(s, "ev_cat");
    expect(said()).toContain("なぞなぞ");
    s = talk(s, "ev_armor", ["人間"]);
    s = talk(s, "ev_cat");
    expect(said()).toContain("書斎の 机");
    s = go(s, "ev_to_dining");
    for (const c of ["white", "red", "green", "blue"]) s = talk(s, `ev_candle_${c}`);
    s = go(s, "ev_to_hall");
    s = talk(s, "ev_cat");
    expect(said()).toContain("開く 音");
  });
});
