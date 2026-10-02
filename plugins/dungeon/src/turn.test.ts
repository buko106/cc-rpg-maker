import { describe, expect, it } from "vitest";
import { testConfig } from "./config.testkit.js";
import type { DungeonState, EnemyState } from "./model.js";
import { arriveAt, attackEnemy, canSee, damage, endTurn, enemyAt, expNeeded, pop, POPUP_FRAMES, reveal, say } from "./turn.js";
import type { EnemyDef, Env, Work } from "./turn.js";

/** `#` 岩、`.` 床、`>` 階段、`$` 宝、`@` プレイヤー（床）、`e` 敵（床）、`f` 速い敵、`s` 遅い敵。 */
function world(rows: string[], opts: { rooms?: DungeonState["rooms"]; hp?: number; belly?: number; turn?: number } = {}): Work {
  const height = rows.length;
  const width = rows[0]!.length;
  let px = 0;
  let py = 0;
  const enemies: EnemyState[] = [];
  const grid = rows
    .flatMap((row, y) =>
      [...row].map((ch, x) => {
        if (ch === "@") [px, py] = [x, y];
        if (ch === "e" || ch === "f" || ch === "s") enemies.push({ id: enemies.length + 1, kind: ch === "e" ? "e_slime" : ch === "f" ? "e_bat" : "e_golem", x, y, fx: x, fy: y, hp: 10, mhp: 10, t: 0 });
        return ch === "@" || ch === "e" || ch === "f" || ch === "s" ? "." : ch;
      }),
    )
    .join("");
  const ds: DungeonState = {
    v: 1, seed: "t", floor: 1, turn: opts.turn ?? 0, belly: opts.belly ?? 100, atkBonus: 0, gold0: 0, width, height, grid, seen: "0".repeat(grid.length),
    rooms: opts.rooms ?? [[1, 1, width - 2, height - 2]], goal: [0, 0], px, py, mhp: 30, atk: 10, def: 4, enemies, items: [], log: [], fx: [], ft: 0, nextId: 99, kills: 0,
  };
  return { ds, hero: { level: 1, exp: 0, hp: opts.hp ?? 30 }, gold: 0, items: {}, tick: 100 };
}

/** 乱数：与えた列を順に返す（足りなくなったら 0）。`int(lo, hi)` は列の値をそのまま（範囲に収めて）返す。 */
const script = (...values: number[]): Env["rng"] => {
  let i = 0;
  const next = (): number => values[i++] ?? 0;
  return { next, int: (lo, hi) => Math.min(hi, Math.max(lo, Math.round(lo + next() * (hi - lo)))) };
};

const enemies = {
  e_slime: { name: "スライム", mhp: 10, atk: 6, def: 2, exp: 5, gold: 3, drops: [{ item: "item_potion", rate: 0.5 }] },
  e_bat: { name: "コウモリ", mhp: 10, atk: 6, def: 0, exp: 4, gold: 2, drops: [] },
  e_golem: { name: "ゴーレム", mhp: 30, atk: 12, def: 8, exp: 20, gold: 10, drops: [] },
} as const;
const envOf = (rng: Env["rng"] = script(), cfg = testConfig()): Env => ({
  cfg,
  heroName: "旅人",
  heroStats: (level) => ({ mhp: 30 + 8 * (level - 1), atk: 10 + 2 * (level - 1), def: 4 }),
  enemy: (id) => (enemies as unknown as Record<string, EnemyDef>)[id],
  itemName: (id) => (id === "item_potion" ? "くすり草" : id),
  rng,
});
// int(-1, 1) は next() の値で決まる：0.5 → 0（ぶれなし）
const MID = 0.5;

describe("damage", () => {
  it("攻撃力 − 防御力の半分 ± 1。最低 1", () => {
    expect(damage(10, 4, script(MID))).toBe(8);
    expect(damage(10, 4, script(0))).toBe(7);
    expect(damage(10, 4, script(1))).toBe(9);
    expect(damage(1, 50, script(0))).toBe(1);
  });
});

describe("canSee / reveal", () => {
  it("部屋の中では部屋全体（壁を含む）、通路では近く（歩いて数歩）だけが見える。歩いた場所を覚える", () => {
    const w = world(["#########", "#@..#...#", "#...#...#", "####.####", "#########"], { rooms: [[1, 1, 3, 2], [5, 1, 3, 2]] });
    expect(canSee(w.ds, 3, 2)).toBe(true);
    expect(canSee(w.ds, 4, 1)).toBe(true); // 壁
    expect(canSee(w.ds, 6, 1)).toBe(false); // 隣の部屋
    reveal(w.ds);
    expect(w.ds.seen[1 * 9 + 3]).toBe("1");
    expect(w.ds.seen[1 * 9 + 6]).toBe("0");
    // 通路
    w.ds.px = 4;
    w.ds.py = 3;
    expect(canSee(w.ds, 4, 2)).toBe(true);
    expect(canSee(w.ds, 7, 2)).toBe(false);
    reveal(w.ds);
    expect(w.ds.seen[2 * 9 + 4]).toBe("1");
    expect(w.ds.seen[1 * 9 + 3]).toBe("1"); // 前に見た場所は残る
  });
});

describe("attackEnemy", () => {
  it("ダメージを与えて、数字とログを残す。倒すと経験値・お金・ドロップを得る", () => {
    const w = world(["#####", "#@e.#", "#####"]);
    const env = envOf(script(MID, 0.1));
    const e = enemyAt(w.ds, 2, 1)!;
    e.hp = 12;
    attackEnemy(w, env, e); // 10 - 1 = 9
    expect(e.hp).toBe(3);
    expect(w.ds.fx.at(-1)).toMatchObject({ x: 2, y: 1, text: "9", tone: "dmg" });
    expect(w.ds.log.at(-1)).toContain("スライムに 9ダメージ");
    expect(w.hero.exp).toBe(0);
    attackEnemy(w, env, e);
    expect(w.ds.enemies).toEqual([]);
    expect(w.ds.kills).toBe(1);
    expect(w.hero.exp).toBe(5);
    expect(w.gold).toBe(3);
    expect(w.ds.items).toEqual([{ key: "drop:item_potion", x: 2, y: 1, amt: 0 }]); // ドロップ（rate 0.5 に対して 0.1）
    expect(w.ds.log.at(-1)).toContain("たおした");
  });

  it("ドロップの乱数が外れたら落とさない。すでに物のあるマスには落とさない", () => {
    const w = world(["#####", "#@e.#", "#####"]);
    const e = enemyAt(w.ds, 2, 1)!;
    e.hp = 1;
    attackEnemy(w, envOf(script(MID, 0.9)), e);
    expect(w.ds.items).toEqual([]);
    const w2 = world(["#####", "#@e.#", "#####"]);
    w2.ds.items.push({ key: "gold", x: 2, y: 1, amt: 5 });
    const e2 = enemyAt(w2.ds, 2, 1)!;
    e2.hp = 1;
    attackEnemy(w2, envOf(script(MID, 0.1)), e2);
    expect(w2.ds.items).toHaveLength(1);
  });

  it("経験値がたまるとレベルが上がり、最大 HP が増えた分だけ HP も増える。一度に複数レベル上がることもある", () => {
    const w = world(["#####", "#@e.#", "#####"], { hp: 20 });
    w.hero.exp = expNeeded(1) - 1;
    const e = enemyAt(w.ds, 2, 1)!;
    e.hp = 1;
    attackEnemy(w, envOf(script(MID, 0.9)), e);
    expect(w.hero.level).toBe(2);
    expect(w.hero.hp).toBe(28);
    expect(w.ds.mhp).toBe(38);
    expect(w.ds.atk).toBe(12);
    expect(w.ds.log.some((l) => l.includes("レベル2"))).toBe(true);
    expect(w.ds.fx.some((f) => f.text === "LEVEL UP!")).toBe(true);

    const big = world(["#####", "#@e.#", "#####"]);
    big.hero.exp = expNeeded(3) + 5;
    const g = enemyAt(big.ds, 2, 1)!;
    g.hp = 1;
    attackEnemy(big, envOf(script(MID, 0.9)), g);
    expect(big.hero.level).toBe(4);
  });

  it("expNeeded は増えていく", () => {
    expect([1, 2, 3, 4].map(expNeeded)).toEqual([15, 45, 90, 150]);
  });
});

describe("arriveAt", () => {
  const stand = (item: { key: string; amt?: number }, extra: Partial<Work["ds"]> = {}): Work => {
    const w = world(["#####", "#@..#", "#####"]);
    w.ds.items.push({ key: item.key, x: 2, y: 1, amt: item.amt ?? 0 });
    Object.assign(w.ds, extra);
    return w;
  };

  it("歩いた位置を覚え、見える範囲が増える", () => {
    const w = world(["#####", "#@..#", "#####"]);
    arriveAt(w, envOf(), 2, 1);
    expect([w.ds.px, w.ds.py]).toEqual([2, 1]);
    expect(w.ds.seen[1 * 5 + 2]).toBe("1");
  });

  it("アイテムは持ち物に入る（敵のドロップも）", () => {
    const w = stand({ key: "potion" });
    arriveAt(w, envOf(), 2, 1);
    expect(w.items).toEqual({ item_potion: 1 });
    expect(w.ds.items).toEqual([]);
    expect(w.ds.log.at(-1)).toBe("くすり草を ひろった");
    const d = stand({ key: "drop:item_potion" });
    d.items = { item_potion: 2 };
    arriveAt(d, envOf(), 2, 1);
    expect(d.items).toEqual({ item_potion: 3 });
  });

  it("おにぎりはその場で食べて満腹度が増える（上限まで）", () => {
    const w = stand({ key: "onigiri" }, { belly: 30 });
    arriveAt(w, envOf(), 2, 1);
    expect(w.ds.belly).toBe(70);
    expect(w.ds.fx.at(-1)).toMatchObject({ text: "+40", tone: "heal" });
    const full = stand({ key: "onigiri" }, { belly: 90 });
    arriveAt(full, envOf(), 2, 1);
    expect(full.ds.belly).toBe(100);
  });

  it("お金は所持金に、ちからの種は攻撃力に足される", () => {
    const g = stand({ key: "gold", amt: 25 });
    arriveAt(g, envOf(), 2, 1);
    expect(g.gold).toBe(25);
    const s = stand({ key: "seed" });
    arriveAt(s, envOf(), 2, 1);
    expect(s.ds.atkBonus).toBe(2);
    expect(s.ds.atk).toBe(12);
    // レベルが上がっても種の分は残る
    s.hero.level = 2;
    arriveAt(s, envOf(), 1, 1);
    expect(s.ds.atk).toBe(12);
  });

  it("階段・宝に着くと結果になる。設定にない物は拾って消すだけ", () => {
    const w = world(["#####", "#@>$#", "#####"]);
    arriveAt(w, envOf(), 2, 1);
    expect(w.outcome).toBe("stairs");
    const t = world(["#####", "#@>$#", "#####"]);
    arriveAt(t, envOf(), 3, 1);
    expect(t.outcome).toBe("treasure");
    const unknown = stand({ key: "ghost" });
    arriveAt(unknown, envOf(), 2, 1);
    expect(unknown.ds.items).toEqual([]);
    expect(unknown.outcome).toBeUndefined();
  });
});

describe("endTurn（敵のターン）", () => {
  it("近くの敵は、歩いて近づいてくる（道なりに）。壁の向こうの近い敵は、遠回りになって気づかない", () => {
    const w = world(["#########", "#@.....e#", "#########"]);
    endTurn(w, envOf(script(MID)));
    expect(w.ds.enemies[0]).toMatchObject({ x: 6, y: 1, fx: 7, fy: 1, t: 100 });
    expect(w.ds.turn).toBe(1);

    const far = world(["#########", "#@.#...e#", "#..#.#.##", "#........#", "#########"], { rooms: [] });
    const cfg = testConfig({ sight: 3 });
    endTurn(far, envOf(script(0.99), cfg)); // うろうろの確率（0.6）に外れる → 動かない
    expect(far.ds.enemies[0]).toMatchObject({ x: 7, y: 1 });
  });

  it("隣にいる敵は攻撃する（防御力の半分を引く）。倒れたら outcome が dead になる", () => {
    const w = world(["#####", "#@e.#", "#####"], { hp: 5 });
    endTurn(w, envOf(script(MID)));
    expect(w.hero.hp).toBe(1); // 6 - 2 = 4
    expect(w.ds.fx.at(-1)).toMatchObject({ x: 1, y: 1, text: "4", tone: "hurt" });
    expect(w.outcome).toBeUndefined();
    w.ds.turn = 1;
    endTurn(w, envOf(script(MID)));
    expect(w.hero.hp).toBeLessThanOrEqual(0);
    expect(w.outcome).toBe("dead");
    expect(w.ds.log.at(-1)).toContain("ちからつきた");
  });

  it("敵どうしは同じマスに重ならない。プレイヤーのいるマスにも入らない", () => {
    const w = world(["######", "#@..ee#", "######"]);
    endTurn(w, envOf(script(MID)));
    const cells = w.ds.enemies.map((e) => `${e.x},${e.y}`);
    expect(new Set(cells).size).toBe(2);
    expect(w.ds.enemies.map((e) => e.x).sort()).toEqual([3, 4]); // 前の敵が詰まっているので、後ろは動けない
  });

  it("速い敵は 1 ターンに 2 回動く。遅い敵は 2 ターンに 1 回", () => {
    const fast = world(["###########", "#@......f.#", "###########"]);
    endTurn(fast, envOf());
    expect(fast.ds.enemies[0]).toMatchObject({ x: 6, fx: 8 }); // 2 マス
    const slow = world(["###########", "#@......s.#", "###########"], { turn: 0 });
    endTurn(slow, envOf()); // turn 1（奇数）→ 動かない
    expect(slow.ds.enemies[0]).toMatchObject({ x: 8 });
    endTurn(slow, envOf()); // turn 2（偶数）→ 動く
    expect(slow.ds.enemies[0]).toMatchObject({ x: 7 });
  });

  it("速い敵が隣にいると、1 ターンに 2 回攻撃する", () => {
    const w = world(["####", "#@f#", "####"], { hp: 30 });
    endTurn(w, envOf(script(MID, MID)));
    expect(w.hero.hp).toBe(30 - 4 * 2);
  });

  it("気づいていない敵は、近くを うろうろする（壁には入らない）", () => {
    for (let n = 0; n < 40; n++) {
      const w = world(["#######", "#@....e#", "#######"]);
      const cfg = testConfig({ sight: 1 });
      endTurn(w, envOf(script(0.1, (n % 4) / 4 + 0.01), cfg));
      const e = w.ds.enemies[0]!;
      expect(w.ds.grid[e.y * w.ds.width + e.x]).toBe(".");
      expect(Math.abs(e.x - 6) + Math.abs(e.y - 1)).toBeLessThanOrEqual(1);
    }
  });

  it("満腹度は interval ターンごとに 1 減る。減るたびのしきい値でログが出る", () => {
    const cfg = testConfig({ belly: { max: 100, interval: 4, hungry: 30, weak: 10, starveDamage: 1 } });
    const w = world(["###", "#@#", "###"], { belly: 31, turn: 3 });
    endTurn(w, envOf(script(), cfg)); // turn 4
    expect(w.ds.belly).toBe(30);
    expect(w.ds.log.at(-1)).toContain("おなかが すいてきた");
    w.ds.turn = 7;
    w.ds.belly = 11;
    endTurn(w, envOf(script(), cfg));
    expect(w.ds.log.at(-1)).toContain("ふらふら");
    w.ds.turn = 11;
    w.ds.belly = 1;
    endTurn(w, envOf(script(), cfg));
    expect(w.ds.belly).toBe(0);
    expect(w.ds.log.at(-1)).toContain("ぺこぺこ");
    const idle = world(["###", "#@#", "###"], { belly: 50, turn: 0 });
    endTurn(idle, envOf(script(), cfg)); // turn 1
    expect(idle.ds.belly).toBe(50);
  });

  it("満腹度が 0 のあいだは、毎ターン HP が減って回復しない。0 になったら倒れる", () => {
    const w = world(["###", "#@#", "###"], { belly: 0, hp: 2 });
    endTurn(w, envOf());
    expect(w.hero.hp).toBe(1);
    expect(w.ds.fx.at(-1)).toMatchObject({ tone: "hurt", text: "1" });
    endTurn(w, envOf());
    expect(w.outcome).toBe("dead");
    expect(w.ds.log.at(-1)).toContain("空腹");
  });

  it("満腹度があれば、regenInterval ターンごとに HP が 1 回復する（最大まで）", () => {
    const w = world(["###", "#@#", "###"], { hp: 10, turn: 5 });
    endTurn(w, envOf()); // turn 6
    expect(w.hero.hp).toBe(11);
    endTurn(w, envOf()); // turn 7
    expect(w.hero.hp).toBe(11);
    const full = world(["###", "#@#", "###"], { hp: 30, turn: 5 });
    endTurn(full, envOf());
    expect(full.hero.hp).toBe(30);
  });
});

describe("ログとポップアップ", () => {
  it("ログは最新の 6 行だけ。ポップアップは古いものから消える（数と時間で）", () => {
    const w = world(["###", "#@#", "###"]);
    for (let i = 0; i < 9; i++) say(w, `m${i}`);
    expect(w.ds.log).toEqual(["m3", "m4", "m5", "m6", "m7", "m8"]);
    for (let i = 0; i < 12; i++) pop(w, 1, 1, String(i), "dmg");
    expect(w.ds.fx).toHaveLength(8);
    expect(w.ds.fx[0]?.text).toBe("4");
    w.tick += POPUP_FRAMES + 1;
    pop(w, 1, 1, "new", "info");
    expect(w.ds.fx.map((f) => f.text)).toEqual(["new"]);
  });
});
