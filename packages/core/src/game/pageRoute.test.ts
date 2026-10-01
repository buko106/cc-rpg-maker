import type { EventPage, MapEvent, MoveRoute } from "@rpg/schema";
import { cmd, loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput, inputFrame } from "../input.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Loaded = ReturnType<typeof loadFixtureProject>;

/** minimal の NPC を取り除き、テスト用のイベントだけを置いたプロジェクトを作る。 */
function setup(...events: MapEvent[]): Loaded {
  const loaded = loadFixtureProject("minimal");
  const map = loaded.maps["map_start" as never]!;
  (map as { events: unknown }).events = Object.fromEntries(events.map((e) => [e.id, e]));
  return loaded;
}
const page = (o: Partial<EventPage>): EventPage => ({ conditions: [], trigger: "action", through: false, priority: "same", commands: [], ...o });
const event = (id: string, x: number, y: number, ...pages: EventPage[]): MapEvent => ({ id: id as never, name: id, x, y, pages });
const route = (steps: MoveRoute["steps"], o: Partial<MoveRoute> = {}): MoveRoute => ({ repeat: false, skippable: false, steps, ...o });
const sw = (id: string, value = true): PageCondition => ({ kind: "switch", id: id as never, value });
type PageCondition = EventPage["conditions"][number];

const at = (s: GameState, id: string): { x: number; y: number; direction: string } => {
  const e = s.map.events[id as never]!;
  return { x: e.x, y: e.y, direction: e.direction };
};
function frames(state: GameState, n: number, ctx: Loaded["ctx"]): GameState {
  let s = state;
  for (let i = 0; i < n; i++) s = step(s, emptyInput(), ctx).state;
  return s;
}
const warns = (effects: { kind: string; level?: string }[]) => effects.filter((e) => e.kind === "log" && e.level === "warn");

describe("ページの moveRoute（自律移動）", () => {
  it("有効なページの moveRoute を、ゲームが始まったら勝手に実行する。repeat でなければ一度だけ", () => {
    const { ctx } = setup(event("npc", 4, 5, page({ moveRoute: route([{ kind: "move", dir: "right" }, { kind: "move", dir: "right" }, { kind: "turn", dir: "up" }]) })));
    const s = frames(initialState(ctx, "s"), 120, ctx);
    expect(at(s, "npc")).toEqual({ x: 6, y: 5, direction: "up" });
    // 終わったあとも、ページが有効な間は同じルートを再起動しない
    expect(at(frames(s, 300, ctx), "npc")).toEqual({ x: 6, y: 5, direction: "up" });
  });

  it("repeat は繰り返す。時間のかからない歩だけのルートでもフレームを食い尽くさない", () => {
    const { ctx } = setup(
      event("walker", 4, 5, page({ moveRoute: route([{ kind: "move", dir: "right" }, { kind: "move", dir: "left" }], { repeat: true }) })),
      event("turner", 7, 1, page({ moveRoute: route([{ kind: "turn", dir: "up" }, { kind: "turn", dir: "down" }], { repeat: true }) })),
    );
    let s = initialState(ctx, "s");
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const r = step(s, emptyInput(), ctx);
      s = r.state;
      expect(warns(r.effects)).toEqual([]);
      seen.add(at(s, "walker").x);
    }
    expect([...seen].sort()).toEqual([4, 5]);
  });

  it("moveRoute の無いページ・空のルート・無効なページは動かさない", () => {
    const { ctx } = setup(
      event("still", 4, 5, page({})),
      event("empty", 5, 5, page({ moveRoute: route([], { repeat: true }) })),
      event("off", 6, 5, page({ conditions: [sw("go")], moveRoute: route([{ kind: "move", dir: "down" }]) })),
    );
    const s = frames(initialState(ctx, "s"), 60, ctx);
    expect([at(s, "still").x, at(s, "empty").x, at(s, "off").y]).toEqual([4, 5, 5]);
    expect(s.interpreters).toEqual([]);
  });

  it("ページが切り替わると古いルートは止まり、新しいページのルートが始まる", () => {
    const setGo = cmd("ControlSwitches", { ids: ["go"], value: true });
    const { ctx } = setup(
      event(
        "npc", 4, 5,
        page({ conditions: [sw("go", false)], moveRoute: route([{ kind: "move", dir: "right" }], { repeat: true, skippable: true }) }),
        page({ conditions: [sw("go")], moveRoute: route([{ kind: "turn", dir: "up" }]) }),
      ),
      event("switcher", 1, 1, page({ trigger: "parallel", conditions: [sw("go", false)], commands: [cmd("Wait", { frames: 40 }), setGo] })),
    );
    const before = frames(initialState(ctx, "s"), 30, ctx);
    expect(at(before, "npc").x).toBeGreaterThan(4);
    const after = frames(before, 200, ctx);
    const x = at(after, "npc").x;
    expect(at(after, "npc").direction).toBe("up");
    expect(at(frames(after, 100, ctx), "npc").x).toBe(x); // もう歩かない
    expect(after.interpreters.filter((i) => i.origin.kind === "plugin")).toHaveLength(1);
  });

  it("通常のイベントの実行中・メッセージ表示中は止まり、終われば再開する", () => {
    const talk = event("talker", 4, 2, page({ trigger: "autorun", conditions: [sw("done", false)], commands: [cmd("ShowText", { text: "やあ" }), cmd("ControlSwitches", { ids: ["done"], value: true })] }));
    const { ctx } = setup(talk, event("npc", 4, 5, page({ moveRoute: route([{ kind: "move", dir: "right" }], { repeat: true, skippable: true }) })));
    let s = frames(initialState(ctx, "s"), 3, ctx);
    expect(s.message.open).toBe(true);
    const held = at(frames(s, 1, ctx), "npc").x;
    s = frames(s, 120, ctx);
    expect(at(s, "npc").x).toBe(held); // メッセージが開いている間は動かない
    // 決定ボタンで閉じると再開する
    for (let i = 0; i < 4; i++) s = step(s, inputFrame(["ok"], i === 0 ? ["ok"] : []), ctx).state;
    s = frames(s, 120, ctx);
    expect(s.message.open).toBe(false);
    expect(at(s, "npc").x).toBeGreaterThan(held);
  });

  it("通れないときは警告を出さずに待ち、skippable なら先へ進む", () => {
    const wall = route([{ kind: "move", dir: "up" }, { kind: "move", dir: "down" }]);
    const { ctx } = setup(event("a", 0, 0, page({ moveRoute: wall })), event("b", 0, 1, page({ moveRoute: { ...wall, steps: [{ kind: "move", dir: "up" }, { kind: "turn", dir: "right" }], skippable: true } })));
    let s = initialState(ctx, "s");
    for (let i = 0; i < 200; i++) {
      const r = step(s, emptyInput(), ctx);
      s = r.state;
      expect(warns(r.effects)).toEqual([]);
    }
    expect(at(s, "a").y).toBe(0);
  });

  it("skippable でないルートは、通れるまで待ち続ける。とうせんぼされても、解けたら同じ往復に戻る（ずれていかない）", () => {
    const { ctx } = setup(event("chick", 4, 5, page({ moveRoute: route([{ kind: "move", dir: "right" }, { kind: "move", dir: "left" }], { repeat: true }) })));
    const blockedAt = (s: GameState): GameState => ({ ...s, map: { ...s.map, player: { ...s.map.player, x: 5, y: 5 } } });
    let s = blockedAt(initialState(ctx, "s"));
    for (let i = 0; i < 400; i++) {
      const r = step(blockedAt(s), emptyInput(), ctx);
      s = r.state;
      expect(warns(r.effects)).toEqual([]);
    }
    expect(at(s, "chick")).toMatchObject({ x: 4, y: 5 }); // 右へ行けないまま待っている
    // プレイヤーがどいたら、右へ 1 歩、左へ 1 歩、を続ける（右へ追いやられない）
    const xs = new Set<number>();
    s = { ...s, map: { ...s.map, player: { ...s.map.player, x: 1, y: 1 } } };
    for (let i = 0; i < 400; i++) {
      s = step(s, emptyInput(), ctx).state;
      xs.add(at(s, "chick").x);
    }
    expect([...xs].sort()).toEqual([4, 5]);
  });

  it("プレイヤーの居るタイルには入らない。through や下のプライオリティなら入れる", () => {
    const { ctx } = setup();
    const start = initialState(ctx, "s");
    const p = start.map.player;
    const side = { x: p.x + 1, y: p.y };
    const left = route([{ kind: "move", dir: "left" }]);
    const { ctx: c2 } = setup(
      event("solid", side.x, side.y, page({ moveRoute: left })),
      event("ghost", side.x, side.y + 1, page({ through: true, moveRoute: route([{ kind: "move", dir: "up" }, { kind: "move", dir: "left" }]) })),
    );
    const s = frames(initialState(c2, "s"), 100, c2);
    expect(at(s, "solid")).toMatchObject({ x: side.x, y: side.y });
    expect(at(s, "ghost").x).toBe(p.x);
  });

  it("SetMoveRoute で強制的に動かしている間は、自律移動は止まる", () => {
    const force = event("forcer", 1, 1, page({ trigger: "autorun", conditions: [sw("done", false)], commands: [cmd("SetMoveRoute", { target: "npc", wait: false, route: route([{ kind: "wait", frames: 60 }, { kind: "turn", dir: "left" }]) }), cmd("ControlSwitches", { ids: ["done"], value: true })] }));
    const { ctx } = setup(force, event("npc", 4, 5, page({ moveRoute: route([{ kind: "move", dir: "right" }, { kind: "move", dir: "right" }, { kind: "move", dir: "right" }]) })));
    let s = frames(initialState(ctx, "s"), 20, ctx);
    const x = at(s, "npc").x;
    s = frames(s, 20, ctx);
    expect(at(s, "npc").x).toBe(x); // 強制ルートの待ちの間は進まない
    s = frames(s, 300, ctx);
    expect(at(s, "npc").x).toBe(7); // 終われば自律移動が続きから
  });

  it("別のマップへ移ったら、古いマップの自律移動は残らない", () => {
    const { ctx } = setup(event("npc", 4, 5, page({ moveRoute: route([{ kind: "move", dir: "right" }], { repeat: true, skippable: true }) })));
    const s0 = frames(initialState(ctx, "s"), 5, ctx);
    expect(s0.interpreters).toHaveLength(1);
    const gone = { ...s0, map: { ...s0.map, transfer: { to: "map_start" as never, x: 1, y: 1, dir: "down" as const, fade: "none" as const, requested: false } } };
    const s1 = step(gone, emptyInput(), ctx).state;
    expect(s1.map.transfer).toBeUndefined();
    expect(s1.interpreters).toEqual([]); // 移動で止まる
    expect(step(s1, emptyInput(), ctx).state.interpreters).toHaveLength(1); // 移動先のページで起動し直される
  });

  it("決定的：同じ入力からは同じ状態になる（random を含む）", () => {
    const build = () => setup(event("npc", 4, 5, page({ moveRoute: route([{ kind: "move", dir: "random" }, { kind: "wait", frames: 5 }], { repeat: true, skippable: true }) })));
    const a = build();
    const b = build();
    const run = (l: Loaded) => frames(initialState(l.ctx, "seed"), 400, l.ctx);
    expect(run(a)).toEqual(run(b));
  });
});

describe("イベントから接触（eventTouch）", () => {
  // minimal のプレイヤーは (2, 2) から始まる。マップは 10×8 で、まわりが壁
  const toward = (o: Partial<MoveRoute> = {}) => route([{ kind: "move", dir: "toward" }], { repeat: true, ...o });
  const caught = (o: Partial<EventPage> = {}) => page({ trigger: "eventTouch", moveRoute: toward(), commands: [cmd("ControlVariables", { ids: ["n"], op: "add", operand: { kind: "constant", value: 1 } })], ...o });
  const n = (s: GameState): number => (s.variables as Record<string, number>)["n"] ?? 0;

  it("近づいてきたイベントがプレイヤーのタイルへ進もうとすると、そのページが始まる。入らずにプレイヤーの方を向く", () => {
    const { ctx } = setup(event("ghost", 6, 2, caught({ commands: [cmd("ShowText", { text: "つかまえた！" })] })));
    let s = initialState(ctx, "s");
    let started = -1;
    for (let i = 0; i < 200 && started < 0; i++) {
      s = step(s, emptyInput(), ctx).state;
      if (s.interpreters.some((it) => it.mode === "normal")) started = i;
    }
    expect(started).toBeGreaterThan(0);
    expect(at(s, "ghost")).toEqual({ x: 3, y: 2, direction: "left" });
    s = frames(s, 2, ctx);
    expect(s.message.open).toBe(true);
    // 実行中はプレイヤーは動けず、イベントも止まっている
    s = step(s, inputFrame(["down"], ["down"]), ctx).state;
    expect(s.map.player).toMatchObject({ x: 2, y: 2 });
    expect(at(frames(s, 30, ctx), "ghost")).toEqual({ x: 3, y: 2, direction: "left" });
  });

  it("接触（touch）のイベントは、向こうから触れてきても始まらない", () => {
    const { ctx } = setup(event("ghost", 6, 2, caught({ trigger: "touch" })));
    const s = frames(initialState(ctx, "s"), 200, ctx);
    expect(n(s)).toBe(0);
    expect(at(s, "ghost")).toMatchObject({ x: 3, y: 2 }); // 隣で待っている
  });

  it("プレイヤーから触れても始まる（突き当たる・下のプライオリティなら上に乗る）", () => {
    const still = (o: Partial<EventPage>) => page({ trigger: "eventTouch", commands: [cmd("ControlVariables", { ids: ["n"], op: "add", operand: { kind: "constant", value: 1 } })], ...o });
    const { ctx } = setup(event("wall", 3, 2, still({})), event("mat", 2, 3, still({ priority: "below" })));
    let s = frames(initialState(ctx, "s"), 1, ctx);
    s = step(s, inputFrame(["right"], ["right"]), ctx).state;
    s = frames(s, 5, ctx);
    expect(n(s)).toBe(1);
    expect(s.map.player).toMatchObject({ x: 2, y: 2 });
    s = step(s, inputFrame(["down"], ["down"]), ctx).state;
    s = frames(s, 30, ctx);
    expect(s.map.player).toMatchObject({ x: 2, y: 3 });
    expect(n(s)).toBe(2);
  });

  it("壁ごしには触れない。下のプライオリティのイベントは向こうからは触れない", () => {
    // (2,1) の上は壁の行。上から下りてこられないので、(2,0) のイベントは触れられない
    const { ctx } = setup(
      event("behind", 2, 0, caught({ moveRoute: route([{ kind: "move", dir: "down" }], { repeat: true }) })),
      event("low", 5, 2, caught({ priority: "below" })),
    );
    const s = frames(initialState(ctx, "s"), 200, ctx);
    expect(n(s)).toBe(0);
    expect(at(s, "behind")).toMatchObject({ x: 2, y: 0 });
  });

  it("通り抜け（through）のイベントは、壁を抜けてきて触れる", () => {
    const { ctx } = setup(event("ghost", 2, 7, caught({ through: true })));
    let s = initialState(ctx, "s");
    for (let i = 0; i < 300 && n(s) === 0; i++) s = step(s, emptyInput(), ctx).state;
    expect(n(s)).toBe(1);
    expect(at(s, "ghost")).toMatchObject({ x: 2, y: 3, direction: "up" });
  });

  it("終わったあとも、触れ続けていれば何度でも始まる。通常のイベントの実行中は始まらない", () => {
    const { ctx } = setup(
      event("ghost", 4, 2, caught()),
      event("talk", 8, 6, page({ trigger: "autorun", conditions: [{ kind: "switch", id: "done" as never, value: false }], commands: [cmd("Wait", { frames: 60 }), cmd("ControlSwitches", { ids: ["done"], value: true })] })),
    );
    let s = frames(initialState(ctx, "s"), 50, ctx);
    expect(n(s)).toBe(0); // 自動実行の間は（自律移動も）止まっている
    s = frames(s, 200, ctx);
    expect(n(s)).toBeGreaterThan(1);
  });

  it("触れたイベントがプレイヤーを入口へ戻すと、イベントも元の位置からやり直す", () => {
    const back = cmd("TransferPlayer", { mapId: "map_start", x: 8, y: 6, dir: "up", fade: "none" });
    const { ctx } = setup(event("ghost", 6, 2, caught({ commands: [back] })));
    let s = initialState(ctx, "s");
    for (let i = 0; i < 300 && s.map.player.x === 2; i++) s = step(s, emptyInput(), ctx).state;
    expect(s.map.player).toMatchObject({ x: 8, y: 6 });
    expect(at(s, "ghost")).toMatchObject({ x: 6, y: 2 });
  });

  it("SetMoveRoute で動かしたときも触れる（プレイヤーのタイルへは入らない）", () => {
    const push = event("push", 8, 6, page({ trigger: "autorun", conditions: [{ kind: "switch", id: "done" as never, value: false }], commands: [cmd("ControlSwitches", { ids: ["done"], value: true }), cmd("SetMoveRoute", { target: "ghost", wait: false, route: route([{ kind: "move", dir: "left" }, { kind: "move", dir: "left" }], { skippable: true }) })] }));
    const { ctx } = setup(push, event("ghost", 4, 2, page({ trigger: "eventTouch", commands: [cmd("ControlVariables", { ids: ["n"], op: "add", operand: { kind: "constant", value: 1 } })] })));
    const s = frames(initialState(ctx, "s"), 120, ctx);
    expect(n(s)).toBe(1);
    expect(at(s, "ghost")).toMatchObject({ x: 3, y: 2, direction: "left" });
  });
});
