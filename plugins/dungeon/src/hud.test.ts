import { describe, expect, it } from "vitest";
import { boot, nextMove } from "./harness.testkit.js";
import type { Game } from "./harness.testkit.js";
import { dungeonHud } from "./hud.js";
import { canSee } from "./turn.js";
import { testConfig } from "./config.testkit.js";

type Frame = ReturnType<Game["h"]["runtime"]["project"]>;
const flat = (nodes: Frame["ui"]): { kind: string; text?: string; ratio?: number; w?: number }[] =>
  nodes.flatMap((n) => [n as { kind: string; text?: string }, ...("children" in n ? flat(n.children) : [])]);
const textsOf = (f: Frame): string[] => flat(f.ui).flatMap((n) => (n.kind === "text" ? [n.text ?? ""] : []));
const layer = (f: Frame, z: number) => f.layers.find((l) => l.kind === "sprites" && l.z === z);

describe("HUD（projection.after）", () => {
  it("ダンジョンの外（町）では何も足さない", async () => {
    const g = await boot("hud-town");
    g.idle(2);
    const f = g.h.runtime.project();
    expect(layer(f, 90)).toBeUndefined();
    expect(layer(f, 150)).toBeUndefined();
    expect(textsOf(f).some((t) => t.includes("地下"))).toBe(false);
    // 設定が読めないときも、ダンジョンの状態があっても何もしない
    expect(dungeonHud(f, g.state(), undefined)).toBe(f);
  });

  it("歩いていない場所のタイルは描かない。敵は見えているものだけ描く。物は歩いた場所にあるものだけ", async () => {
    const g = await boot("hud-seen");
    await g.enter();
    const ds = g.ds()!;
    const f = g.h.runtime.project();
    const tiles = f.layers.find((l) => l.kind === "tiles")!;
    if (tiles.kind !== "tiles") throw new Error("tiles");
    let shown = 0;
    tiles.tiles.forEach((t, i) => {
      if (ds.seen[i] === "0") expect(t).toBe(0);
      else if (t !== 0) shown++;
    });
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(ds.grid.length / 2);
    const enemies = layer(f, 150);
    const visible = ds.enemies.filter((e) => canSee(ds, e.x, e.y));
    expect(enemies?.kind === "sprites" && enemies.sprites).toHaveLength(visible.length);
    const items = layer(f, 90);
    expect(items?.kind === "sprites" && items.sprites).toHaveLength(ds.items.filter((i) => ds.seen[i.y * ds.width + i.x] === "1").length);
    // 敵・物の層は、タイルの層とキャラクターの層の間
    const idx = (z: number) => f.layers.findIndex((l) => l.kind === "sprites" && l.z === z);
    const lastTiles = f.layers.reduce((n, l, i) => (l.kind === "tiles" ? i : n), -1);
    expect(idx(90)).toBeGreaterThan(lastTiles);
    expect(idx(150)).toBeGreaterThan(idx(90));
  });

  it("階・レベル・HP・満腹度・ログ・ミニマップを描く。階に着いた直後は見出しも出て、しばらくすると消える", async () => {
    const g = await boot("hud-ui");
    await g.enter();
    let f = g.h.runtime.project();
    const t = textsOf(f);
    expect(t.filter((x) => x === "地下 1 階")).toHaveLength(2); // ステータスと見出し
    expect(t).toEqual(expect.arrayContaining(["Lv 1", "30/30", "100/100", "ダンジョンに 入った。"]));
    // ミニマップ：歩いた床の帯と、自分の位置
    const gauges = flat(f.ui).filter((n) => n.kind === "gauge");
    expect(gauges.length).toBeGreaterThan(4);
    await g.idle(130);
    f = g.h.runtime.project();
    expect(textsOf(f).filter((x) => x === "地下 1 階")).toHaveLength(1);
  });

  it("攻撃・被ダメージの数字が出て、時間がたつと消える。HP が減るとゲージと数字が変わる", async () => {
    const g = await boot("hud-fight");
    await g.enter();
    // 敵にぶつかるまで進む
    for (let i = 0; i < 300 && !g.ds()!.fx.some((f) => f.tone === "dmg" || f.tone === "hurt"); i++) {
      const ds = g.ds()!;
      const e = [...ds.enemies].sort((a, b) => Math.abs(a.x - ds.px) + Math.abs(a.y - ds.py) - (Math.abs(b.x - ds.px) + Math.abs(b.y - ds.py)))[0]!;
      const dir = nextMove(ds, { x: e.x, y: e.y });
      if (dir === undefined) break;
      await g.step(dir);
    }
    const fx = g.ds()!.fx.at(-1)!;
    expect(textsOf(g.h.runtime.project())).toContain(fx.text);
    await g.idle(80);
    const after = textsOf(g.h.runtime.project());
    expect(after).not.toContain(fx.text); // 数字は 50 フレームで消える
    const hp = g.state().actors["actor_hero" as never]!.hp;
    expect(after).toContain(`${hp}/30`);
  });

  it("[inv] HUD は FrameSpec を変えるだけで、GameState には触れない", async () => {
    const g = await boot("hud-pure");
    await g.enter();
    const s = g.state();
    const json = JSON.stringify(s);
    dungeonHud(g.h.runtime.project(), s, testConfig());
    expect(JSON.stringify(s)).toBe(json);
  });
});
