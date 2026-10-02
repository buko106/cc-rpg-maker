import type { FrameSpec, GameState, UiNode } from "@rpg/plugin-api";
import { describe, expect, it } from "vitest";
import { sampleConfig } from "./config.testkit.js";
import { boot } from "./harness.testkit.js";
import { BAR_W, fishingHud } from "./hud.js";
import { startCast } from "./fish.js";
import { emptyFishing, withFishing } from "./model.js";
import type { CastState, FishingState } from "./model.js";

const cfg = sampleConfig();
const frame: FrameSpec = {
  size: { width: 480, height: 352 },
  camera: { x: 0, y: 0 },
  layers: [{ kind: "tiles", tileset: null, tileSize: 32, width: 1, height: 1, tiles: [0], z: 0 }],
  overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } },
  ui: [],
};
const texts = (ui: readonly UiNode[]): string[] => ui.flatMap((n) => (n.kind === "text" ? [n.text] : n.kind === "window" ? texts(n.children) : []));
const rects = (ui: readonly UiNode[]): UiNode[] => ui.flatMap((n) => (n.kind === "gauge" ? [n] : n.kind === "window" ? rects(n.children) : []));

async function drawn(patch: (fs: FishingState) => FishingState): Promise<UiNode[]> {
  const g = await boot("hud");
  const state: GameState = withFishing(g.state(), patch(emptyFishing()));
  return fishingHud(frame, state, cfg).ui as UiNode[];
}
const cast = (patch: Partial<CastState>): CastState => ({ ...startCast("pier", 0.28, undefined, { next: () => 0.5 }), ...patch });

describe("釣りの表示", () => {
  it("[inv-1] 釣りの状態が無い・設定が不正なときは、FrameSpec をそのまま返す", async () => {
    const g = await boot("hud");
    expect(fishingHud(frame, g.state(), cfg)).toBe(frame);
    expect(fishingHud(frame, withFishing(g.state(), { ...emptyFishing(), tournament: { score: 1, catches: 1, biggest: null } }), undefined)).toBe(frame);
    expect(fishingHud(frame, withFishing(g.state(), emptyFishing()), cfg)).toBe(frame); // 何も出すものが無い
  });

  it("大会中は、点数とつれた数を左上に出す", async () => {
    const ui = await drawn((fs) => ({ ...fs, tournament: { score: 134, catches: 3, biggest: null } }));
    expect(texts(ui)).toEqual(["釣り大会", "134 てん", "つれた魚 3 ひき"]);
  });

  it("待っている間：ウキと「じっと まつ」。エサの名前も出る", async () => {
    const ui = await drawn((fs) => ({ ...fs, cast: cast({ phase: "wait", bait: "エビ" }) }));
    expect(texts(ui).join(" ")).toContain("じっと まつ");
    expect(texts(ui).join(" ")).toContain("エサ：エビ");
    expect(rects(ui).length).toBeGreaterThan(0); // ウキ
  });

  it("あたり：「！」と、残り時間のゲージ", async () => {
    const ui = await drawn((fs) => ({ ...fs, cast: cast({ phase: "bite", left: 20, fish: "aji", size: 15 }) }));
    expect(texts(ui)).toContain("！");
    expect(texts(ui)).toContain("あたりだ！ 決定ボタン！");
    expect(ui.some((n) => n.kind === "window" && n.children.some((c) => c.kind === "gauge" && Math.abs(c.ratio - 0.5) < 1e-9))).toBe(true);
  });

  it("巻き上げ：バー・当たり判定（緑）・魚・巻き上げた量。魚が判定の中か外かで色が変わる", async () => {
    const inside = rects(await drawn((fs) => ({ ...fs, cast: cast({ phase: "reel", fish: "aji", pos: 0.5, zone: 0.5, progress: 0.4 }) })));
    const outside = rects(await drawn((fs) => ({ ...fs, cast: cast({ phase: "reel", fish: "aji", pos: 0.9, zone: 0.3, progress: 0.4 }) })));
    const bars = (r: UiNode[]) => r.filter((n) => n.kind === "gauge" && n.w === BAR_W);
    expect(bars(inside).length).toBeGreaterThanOrEqual(2); // バーの背景と、巻き上げた量
    const fishMarker = (r: UiNode[]) => r.find((n) => n.kind === "gauge" && n.w === 10);
    expect(fishMarker(inside)).toBeDefined();
    expect(JSON.stringify(fishMarker(inside))).not.toBe(JSON.stringify({ ...fishMarker(outside), x: (fishMarker(inside) as { x: number }).x, y: (fishMarker(inside) as { y: number }).y }));
    const zone = (r: UiNode[], size: number) => r.find((n) => n.kind === "gauge" && Math.abs(n.w - size * BAR_W) < 1);
    expect(zone(inside, 0.28)).toBeDefined();
  });

  it("結果：釣れた魚の名前と大きさ・点数・初めての魚。逃げられたときは魚の名前", async () => {
    const result = (kind: "caught" | "lost" | "early", extra = {}) => ({ kind, fish: "aji", size: 21.5, points: 12, record: true, first: true, ...extra });
    const caught = texts(await drawn((fs) => ({ ...fs, cast: cast({ phase: "done", result: result("caught") }) }))).join(" ");
    expect(caught).toContain("アジ  21.5cm");
    expect(caught).toContain("つりあげた！");
    expect(caught).toContain("はじめて つった");
    expect(caught).toContain("＋12 てん");
    expect(texts(await drawn((fs) => ({ ...fs, cast: cast({ phase: "done", result: result("caught", { first: false, record: true, points: 0 }) }) }))).join(" ")).toContain("自己ベスト");
    expect(texts(await drawn((fs) => ({ ...fs, cast: cast({ phase: "done", result: result("lost") }) }))).join(" ")).toContain("アジ だったのに");
    expect(texts(await drawn((fs) => ({ ...fs, cast: cast({ phase: "done", result: result("early") }) }))).join(" ")).toContain("はやく あげすぎた");
  });

  it("つり手帳：釣った魚は名前・最大・数、まだの魚は「？？？？？」。種類の数も出る", async () => {
    const ui = await drawn((fs) => ({ ...fs, album: { aji: { count: 3, best: 24.1 } }, screen: { kind: "album" } }));
    const t = texts(ui);
    expect(t).toContain("つり手帳");
    expect(t).toContain("1 / 6 しゅるい");
    expect(t).toContain("アジ");
    expect(t).toContain("さいだい 24.1cm");
    expect(t).toContain("3 ひき");
    expect(t.filter((x) => x === "？？？？？")).toHaveLength(5);
    const all = await drawn((fs) => ({ ...fs, album: Object.fromEntries(cfg.fish.map((f) => [f.key, { count: 1, best: f.size[0] }])), screen: { kind: "album" } }));
    expect(texts(all)).toContain("ぜんぶの 魚を つりあげた！");
  });

  it("結果発表：順位表（プレイヤーは強調）と、賞金・トロフィー", async () => {
    const ranking = [{ name: "ゴンさん", score: 160, you: false }, { name: "あなた", score: 140, you: true }, { name: "ミナ", score: 70, you: false }];
    const t = texts(await drawn((fs) => ({ ...fs, screen: { kind: "result", ranking, rank: 2, prize: 500, trophy: false, score: 140, catches: 6 } })));
    expect(t).toContain("けっか はっぴょう");
    expect(t.slice(1, 10)).toEqual(["1位", "ゴンさん", "160 てん", "2位", "あなた", "140 てん", "3位", "ミナ", "70 てん"]);
    expect(t).toContain("2位だった");
    expect(t).toContain("賞金 500G");
    const win = texts(await drawn((fs) => ({ ...fs, screen: { kind: "result", ranking: [{ name: "あなた", score: 5, you: true }], rank: 1, prize: 1000, trophy: true, score: 5, catches: 1 } })));
    expect(win).toContain("ゆうしょう！ おめでとう！");
    expect(win).toContain("賞金 1000G　＋　トロフィー");
  });
});
