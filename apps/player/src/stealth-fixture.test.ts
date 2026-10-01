import type { MapData } from "@rpg/schema";
import { drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";

// 忍び込みのデモ（fixtures/projects/v1/stealth。tools/make-stealth-demo.mjs が生成する）の約束ごと
const { maps, ctx } = loadFixtureProject("stealth");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const MAP = "map_manor";
const manor = (): MapData => maps[MAP as keyof typeof maps]!;
const START = { x: 12, y: 17 };
const isGuard = (id: string): boolean => id.startsWith("ev_guard_");
const flag = (s: State, id: string): boolean => s.switches[id as keyof State["switches"]] === true;
const variable = (s: State, id: string): number => s.variables[id as keyof State["variables"]] ?? 0;
const busy = (s: State): boolean => s.map.player.moving || s.map.transfer !== undefined || s.interpreters.some((i) => i.mode === "normal") || s.message.open || s.scene.kind !== "map";
/** 見張りの誰かに見つかっているか（`sw_seen_<番号>`）。 */
const spotted = (s: State): boolean => [1, 2, 3, 4, 5].some((ch) => flag(s, `sw_seen_${ch}`));
const guard = (s: State, ch: number) => Object.values(s.map.events).find((e) => e.id.startsWith(`ev_guard_${ch}_`))!;

/** 進めている間に出たメッセージ。 */
let seen: string[] = [];
const said = (): string => seen.join("\n");

/** メッセージを決定で閉じながら、イベントが終わるまで進める。 */
function settle(state: State, c = ctx): State {
  let s = state;
  for (let i = 0; i < 400 && busy(s); i++) {
    if (s.scene.kind === "title") return s;
    if (s.message.open) {
      s = drive(s, c, idleFrames(2)).state;
      if (s.message.text !== "") seen.push(s.message.text);
      s = drive(s, c, [press("ok"), ...idleFrames(1)]).state;
    } else s = driveUntil(s, c, (x) => !busy(x) || x.message.open || x.scene.kind !== "map", 600);
  }
  return s;
}

const newGame = (seed = "stealth"): State => {
  const s = runReplay({ project: "fixtures/projects/v1/stealth", seed, inputs: [], expect: {} }).state;
  seen = [];
  return settle(driveUntil(s, ctx, busy, 60));
};
/** プレイヤーをそこへ置く（歩かずに）。 */
const place = (s: State, x: number, y: number, direction: Dir = "up"): State => ({ ...s, map: { ...s.map, player: { ...s.map.player, x, y, realX: x, realY: y, direction, moving: false } } });
const idle = (s: State, frames: number, until: (x: State) => boolean = () => false): State => {
  let x = s;
  for (let i = 0; i < frames && !until(x); i++) x = drive(x, ctx, idleFrames(1)).state;
  return x;
};

/** 見張りのうち `keep`（GUARDS の番号）だけを残した状態（状態からほかの見張りのイベントを取り除く）。 */
function only(s: State, ...keep: number[]): State {
  const events = Object.fromEntries(Object.entries(s.map.events).filter(([id]) => !isGuard(id) || keep.some((ch) => id.startsWith(`ev_guard_${ch}_`))));
  return { ...s, map: { ...s.map, events } as State["map"] };
}
/** 見張りが居ない屋敷（宝・扉・門の仕掛けだけを確かめるための）。 */
const quietGame = (): { state: State; ctx: typeof ctx } => ({ state: only(newGame()), ctx });
/** `(x, y)` に立って `dir` を向き、決定ボタンを押して、そのイベントが終わるまで進める。 */
const interact = (s: State, c: typeof ctx, x: number, y: number, dir: Dir, button: "ok" | Dir = "ok"): State => settle(drive(place(s, x, y, dir), c, [press(button), ...idleFrames(1)]).state, c);

describe("fixtures/projects/v1/stealth（忍び込み！月影の宝物庫）", () => {
  it("屋敷は 1 つのマップ。見張りは 5 人で、どのページも「視界 → おいかけて つかまえる」。番犬だけは最後の警報に加わらない", () => {
    expect(Object.keys(maps)).toEqual([MAP]);
    expect([manor().width, manor().height]).toEqual([25, 19]);
    const guards = Object.values(manor().events).filter((e) => isGuard(e.id));
    expect(guards).toHaveLength(5);
    for (const g of guards) {
      const [seeing, ...chasers] = g.pages;
      expect(seeing).toMatchObject({ trigger: "eventSight", priority: "same", moveRoute: { repeat: true } });
      expect(seeing!.sightRange).toBeGreaterThanOrEqual(3);
      // おいかけるページ：自分が見つけたとき（番犬以外は、最後の警報のときも）
      expect(chasers).toHaveLength(g.id.startsWith("ev_guard_4_") ? 1 : 2);
      for (const chasing of chasers) {
        expect(chasing).toMatchObject({ trigger: "eventTouch", priority: "same" });
        expect(chasing.moveRoute!.steps.at(-1)).toEqual({ kind: "move", dir: "chase" });
        expect(chasing.commands.at(-1)).toMatchObject({ code: "TransferPlayer", params: { mapId: MAP, ...START } });
      }
    }
    // 見回りは往復、立ち番は向きを変えるだけ、番犬はうろつく
    const stepKinds = (ch: number) => new Set(Object.values(manor().events).find((e) => e.id.startsWith(`ev_guard_${ch}_`))!.pages[0]!.moveRoute!.steps.map((st) => st.kind));
    expect(stepKinds(1)).toContain("move");
    expect(stepKinds(3)).toEqual(new Set(["turn", "wait"]));
    expect(stepKinds(4)).toContain("move");
  });

  it("はじめは相棒に話しかけてと言われ、侵入口に立っている。見張りはまだ誰も気づいていない", () => {
    const s = newGame();
    expect(said()).toContain("相棒");
    expect(s.map.mapId).toBe(MAP);
    expect(s.map.player).toMatchObject(START);
    expect(flag(s, "sw_alert")).toBe(false);
  });

  it("見張りの正面、視界の長さ以内に入ると見つかって警報が鳴る。視界の外・うしろ・かげなら見つからない", () => {
    // 隊長（20, 3）は下を向いて立っている。視界は 6 タイル：(20, 4)〜(20, 9)
    const seesAt = (x: number, y: number, frames = 40): boolean => spotted(idle(place(newGame(), x, y), frames));
    expect(seesAt(20, 9)).toBe(true);
    expect(seesAt(20, 4)).toBe(true);
    expect(seesAt(20, 10)).toBe(false); // 7 タイル先は見えない
    expect(seesAt(20, 2)).toBe(false); // 背後
    expect(seesAt(18, 4)).toBe(false); // 正面の線の外
    // 立ち番の「広間の見張り」（9, 6）は上を向いて始まり、80 フレームごとに 右・下・左 と向きを変える。右を向くと 6 行目が見える
    expect(seesAt(12, 6, 200)).toBe(true);
    expect(seesAt(12, 7, 200)).toBe(false);
  });

  it("見回りの兵は歩く向きの先が見える。うしろについて歩けば気づかれない", () => {
    // 見回りの兵は（2, 14）から右へ歩く。ほかの見張りは居ないことにする
    const s = only(newGame(), 1);
    expect(guard(s, 1).y).toBe(14);
    expect(spotted(idle(place(s, 8, 14), 60))).toBe(true);
    expect(spotted(idle(place(s, 1, 14), 120))).toBe(false); // うしろ
    expect(spotted(idle(place(s, 8, 13), 120))).toBe(false); // 並んだ道は見えない
  });

  it("見つかると、見張りが追ってきてつかまえる。盗んだ宝はとりあげられて侵入口へ戻され、見張りも元の位置からやり直す", () => {
    let s = only(place(newGame(), 8, 14), 1);
    s = { ...s, switches: { ...s.switches, sw_got1: true } as State["switches"], variables: { ...s.variables, var_loot: 1 } as State["variables"] };
    seen = [];
    for (let i = 0; i < 6000 && variable(s, "var_caught") === 0; i++) s = busy(s) ? settle(s) : drive(s, ctx, idleFrames(10)).state;
    s = settle(s);
    expect(variable(s, "var_caught")).toBe(1);
    expect(said()).toContain("見つかった");
    expect(said()).toContain("つかまった");
    expect(s.map.player).toMatchObject(START);
    expect(spotted(s) || flag(s, "sw_alert")).toBe(false);
    expect(flag(s, "sw_got1")).toBe(false);
    expect(variable(s, "var_loot")).toBe(0);
    // 見張りは元の位置から（見回りの兵は（2, 14）から右へ歩く）
    expect(guard(s, 1).y).toBe(14);
    expect(guard(s, 1).x).toBeLessThanOrEqual(3);
  });

  it("警報のあいだ、見張りは壁をよけて道をたどってくる（広間の見張りが戸口を抜けて中庭へ）", () => {
    // 広間の見張り（9, 6）だけが居る。広間と中庭のあいだの壁（y = 11）には、戸口（12, 11）しかない
    let s = only(place(newGame(), 12, 16, "down"), 5);
    s = { ...s, switches: { ...s.switches, sw_alert: true } as State["switches"] };
    expect(guard(s, 5)).toMatchObject({ x: 9, y: 6 });
    let deepest = 0;
    s = idle(s, 1500, (x) => {
      deepest = Math.max(deepest, guard(x, 5).y);
      return busy(x);
    });
    expect(deepest).toBeGreaterThanOrEqual(12);
    // 追いついて、つかまえる
    expect(variable(settle(s), "var_caught")).toBe(1);
  });

  it("かぎの宝箱 → 宝物庫の扉 → 3 つの宝。最後の宝で警報が鳴る", () => {
    const { state, ctx: c } = quietGame();
    // かぎがないと扉は開かない
    let s = interact(state, c, 12, 6, "up");
    expect(flag(s, "sw_vault")).toBe(false);
    expect(s.map.events["ev_vault" as never]!.pageIndex).toBe(0);
    // 兵舎の宝箱からかぎを取る（宝箱は触れる所に 1 つ）
    s = interact(s, c, 23, 3, "up");
    expect(flag(s, "sw_key")).toBe(true);
    expect(seen.join("\n")).toContain("宝物庫の かぎ");
    // かぎで扉が開く。開いた扉は通れる
    s = interact(s, c, 12, 6, "up");
    expect(flag(s, "sw_vault")).toBe(true);
    s = drive(place(s, 12, 6), c, [...idleFrames(2), press("up"), ...idleFrames(20), press("up"), ...idleFrames(20)]).state;
    expect(s.map.player.y).toBe(4);
    // 宝を 1 つずつ。3 つめで警報
    seen = [];
    s = interact(s, c, 10, 4, "up");
    expect([variable(s, "var_loot"), flag(s, "sw_alert")]).toEqual([1, false]);
    expect(variable(s, "var_left")).toBe(2);
    s = interact(s, c, 12, 4, "up");
    expect([variable(s, "var_loot"), flag(s, "sw_alert")]).toEqual([2, false]);
    s = interact(s, c, 14, 4, "up");
    expect([variable(s, "var_loot"), flag(s, "sw_alert")]).toEqual([3, true]);
    expect(seen.join("\n")).toContain("警報");
    // 取った宝箱は空（もう取れない）
    s = interact(s, c, 10, 4, "up");
    expect(variable(s, "var_loot")).toBe(3);
  });

  it("門：宝がそろっていないと帰れない。3 つそろうと、つかまった回数を告げてタイトルへ", () => {
    const { state, ctx: c } = quietGame();
    seen = [];
    let s = interact(state, c, 12, 17, "down", "down");
    expect(s.scene.kind).toBe("map");
    expect(seen.join("\n")).toContain("まだ 手ぶらでは");
    expect(variable(s, "var_left")).toBe(3);
    s = { ...state, variables: { ...state.variables, var_loot: 3, var_caught: 2 } as State["variables"] };
    seen = [];
    s = interact(s, c, 12, 17, "down", "down");
    expect(seen.join("\n")).toContain("つかまった 回数：\\V[var_caught]回");
    expect(s.scene.kind).toBe("title");
  });

  it("最後の宝で警報が鳴っても、宝物庫から門へ まっすぐ走れば逃げきれる（番犬のほかの見張りがおいかけてくる）", () => {
    // 宝物庫の扉（12, 5）の前から、戸口（12, 11）を抜けて、門（12, 18）の前（12, 17）まで。見張りは本来の位置から動き出す
    const escapes = ["a", "b", "c", "d", "e", "f"].map((seed) => {
      let s = newGame(seed);
      s = { ...s, switches: { ...s.switches, sw_alert: true, sw_vault: true, sw_key: true } as State["switches"], variables: { ...s.variables, var_loot: 3 } as State["variables"] };
      s = place(s, 12, 4, "down");
      for (let i = 0; i < 400 && variable(s, "var_caught") === 0 && !(s.map.player.x === 12 && s.map.player.y === 17); i++) {
        if (busy(s) && !s.map.player.moving) s = settle(s);
        else s = driveUntil(drive(s, ctx, [press("down")]).state, ctx, (x) => !x.map.player.moving, 60);
      }
      return variable(s, "var_caught") === 0;
    });
    expect(escapes.filter(Boolean).length).toBeGreaterThanOrEqual(5);
  });
});
