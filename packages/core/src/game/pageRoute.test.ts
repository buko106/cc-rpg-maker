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
