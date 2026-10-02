import { createPluginRegistry, loadPlugins, toRuntimeExtensions } from "@rpg/plugin-api";
import type { CommandCtx, GameState } from "@rpg/plugin-api";
import { createRuntimeHarness, expandInputs } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createCommands } from "./commands.js";
import { sampleConfig, rngOf } from "./config.testkit.js";
import { blank, boot, hold, press } from "./harness.testkit.js";
import type { Game } from "./harness.testkit.js";
import { fishingPlugin } from "./index.js";
import { emptyFishing, fishingSchema, withFishing } from "./model.js";

const phase = (g: Game): string | undefined => g.fishing()?.cast?.phase;
const inCast = (g: Game): boolean => g.fishing()?.cast !== null && g.fishing()?.cast !== undefined;

/** 竿を振って、あたりを待って、決定ボタンで合わせる。巻き上げの状態になるまで進める。 */
async function castAndHook(g: Game, max = 2000): Promise<void> {
  await g.frames(press("ok"), blank());
  for (let i = 0; i < max && phase(g) !== "bite"; i++) await g.frames(blank());
  expect(phase(g)).toBe("bite");
  await g.frames(press("ok"));
  expect(phase(g)).toBe("reel");
}

/** 巻き上げを最後まで操作して、結果の表示が終わるまで進める。結果の種類を返す。 */
async function reelIn(g: Game, max = 6000): Promise<string | undefined> {
  let kind: string | undefined;
  for (let i = 0; i < max && inCast(g); i++) {
    await g.frames(phase(g) === "reel" ? g.follow() : phase(g) === "done" ? press("ok") : blank());
    kind ??= g.fishing()?.cast?.result?.kind;
  }
  return kind;
}

describe("はじまり", () => {
  it("最初に説明を聞いて、おこづかい 300G とミミズ 8 つをもらう", async () => {
    const g = await boot();
    expect(g.state().map.mapId).toBe("map_harbor");
    await g.intro();
    expect(g.state().party.gold).toBe(300);
    expect(g.items()["item_worm"]).toBe(8);
    expect((g.state().switches as Record<string, boolean>)["sw_intro"]).toBe(true);
    expect(g.h.warnings).toEqual([]);
  });
});

describe("釣り", () => {
  it("桟橋から竿を振る → あたり → 巻き上げ → 釣れる：持ち物・図鑑・エサ・変数に反映される", async () => {
    const g = await boot("catch");
    await g.intro();
    await g.toPier();
    expect(g.state().map.player).toMatchObject({ x: 12, y: 8, direction: "left" });
    await castAndHook(g);
    // 巻き上げの途中に、表示が出ている
    await g.idle(3);
    expect(g.texts()).toContain("まきあげろ！");
    const kind = await reelIn(g);
    expect(kind).toBe("caught");
    expect(g.state().interpreters).toEqual([]); // 終わったら、イベントも終わる
    const fs = g.fishing()!;
    expect(fs.cast).toBeNull();
    const [key, entry] = Object.entries(fs.album)[0]!;
    expect(entry.count).toBe(1);
    expect(g.items()[`item_${key}`]).toBe(1);
    expect(g.items()["item_worm"]).toBe(7); // エサを 1 つ使った
    expect(g.vars()["var_fishing_species"]).toBe(1);
    expect(g.h.warnings).toEqual([]);
  });

  it("あたりの前に決定ボタンを押すと逃げられる。何も釣れず、エサは減る", async () => {
    const g = await boot("early");
    await g.intro();
    await g.toPier();
    await g.frames(press("ok"), blank(), blank(), press("ok"));
    expect(g.fishing()!.cast!.result?.kind).toBe("early");
    expect(g.texts().join("")).toContain("はやく あげすぎた");
    for (let i = 0; i < 200 && inCast(g); i++) await g.frames(blank());
    expect(inCast(g)).toBe(false);
    expect(g.fishing()!.album).toEqual({});
    expect(g.items()["item_worm"]).toBe(7);
  });

  it("キャンセルでやめると、エサが戻って、すぐ動ける", async () => {
    const g = await boot("quit");
    await g.intro();
    await g.toPier();
    await g.frames(press("ok"), blank(), blank(), press("cancel"), blank(), blank());
    expect(inCast(g)).toBe(false);
    expect(g.items()["item_worm"]).toBe(8);
    expect(g.state().interpreters).toEqual([]);
  });

  it("釣っている間は、歩けない・メニューも開かない。終わったら動ける", async () => {
    const g = await boot("lock");
    await g.intro();
    await g.toPier();
    await g.frames(press("ok"), blank());
    const before = g.state().map.player;
    await g.frames(press("down"), blank(), press("down"), blank(), press("menu"), blank());
    expect(g.state().map.player).toMatchObject({ x: before.x, y: before.y });
    expect(g.state().scene.kind).toBe("map");
    await g.frames(press("cancel")); // やめる
    await g.idle(3);
    await g.step("down");
    expect(g.state().map.player.y).toBe(9);
  });

  it("エサを使い切ると、エサなしで振れる（あたりが遅く、手ごわい魚が出にくい）", async () => {
    const g = await boot("bare");
    await g.intro();
    await g.toPier();
    for (let i = 0; i < 8; i++) {
      // 早く押して逃がす（エサは使われる）
      await g.frames(press("ok"), blank(), blank(), press("ok"));
      for (let n = 0; n < 200 && inCast(g); n++) await g.frames(press("ok"));
    }
    expect(g.items()["item_worm"]).toBeUndefined();
    await g.frames(press("ok"), blank());
    const c = g.fishing()!.cast!;
    expect(c.bait).toBeNull();
    expect(c.rare).toBeLessThan(1);
    expect(c.left).toBeGreaterThanOrEqual(Math.round(90 * 1.4) - 1);
  });

  it("沖（桟橋の先）では、スズキ・マダイ・マグロ・ながぐつのどれかが釣れる", async () => {
    const g = await boot("deep");
    await g.intro();
    await g.toDeep();
    expect(g.state().map.player).toMatchObject({ x: 12, y: 3, direction: "up" });
    await g.frames(press("ok"), blank());
    expect(g.fishing()!.cast!.spot).toBe("deep");
    for (let i = 0; i < 2000 && phase(g) !== "bite"; i++) await g.frames(blank());
    expect(["suzuki", "madai", "maguro", "boots"]).toContain(g.fishing()!.cast!.fish);
  });

  it("同じシード・同じ入力なら、同じ魚・同じ大きさ（決定論）", async () => {
    const run = async () => {
      const g = await boot("same");
      await g.intro();
      await g.toPier();
      await castAndHook(g);
      const c = g.fishing()!.cast!;
      return [c.fish, c.size];
    };
    expect(await run()).toEqual(await run());
  });
});

describe("コマンド：竿を振る", () => {
  const cfg = sampleConfig();
  const cast = createCommands(() => ({ ok: true, config: cfg })).find((c) => c.code === "Cast")!;
  const ctx = (state: GameState): CommandCtx => ({ state, rng: rngOf(9), input: { pressed: new Set(), triggered: new Set() } }) as unknown as CommandCtx;
  const withItems = async (items: Record<string, number>): Promise<GameState> => {
    const g = await boot("gear");
    return { ...g.state(), party: { ...g.state().party, items: items as never } };
  };

  it("持っている中で一番良い竿・エサを使い、エサを 1 つ減らす（0 になったら持ち物から消える）", async () => {
    const r = cast.run({ spot: "pier" }, ctx(await withItems({ item_rod1: 1, item_rod2: 1, item_worm: 4, item_lure: 1 })));
    expect(r.control).toEqual({ kind: "wait", wait: { kind: "plugin", name: "fishing" } });
    const fs = fishingSchema.parse(r.state!.pluginState!["fishing"]);
    expect(fs.cast).toMatchObject({ phase: "wait", spot: "pier", zoneSize: 0.36, bait: "ルアー", rare: 3 });
    expect(r.state!.party.items).toEqual({ item_rod1: 1, item_rod2: 1, item_worm: 4 });
  });

  it("竿もエサも無ければ、基本の当たり判定で、エサなし", async () => {
    const r = cast.run({ spot: "pier" }, ctx(await withItems({})));
    expect(fishingSchema.parse(r.state!.pluginState!["fishing"]).cast).toMatchObject({ zoneSize: 0.2, bait: null });
  });

  it("大会の制限時間が来ていたら、何もしない（進行役のイベントが終わらせる）", async () => {
    const s = await withItems({ item_worm: 1 });
    const over = { ...withFishing(s, { ...emptyFishing(), tournament: { score: 5, catches: 1, biggest: null } }), timers: { active: false, ticks: 0 } };
    expect(cast.run({ spot: "pier" }, ctx(over))).toEqual({});
    // 大会に出ていなければ、タイマーが止まっていても振れる
    expect(cast.run({ spot: "pier" }, ctx(s)).control).toMatchObject({ kind: "wait" });
  });

  it("設定が不正なときは、警告を出して何もしない", async () => {
    const bad = createCommands(() => ({ ok: false, message: "設定が不正" })).find((c) => c.code === "Cast")!;
    expect(bad.run({ spot: "pier" }, ctx(await withItems({})))).toMatchObject({ effects: [{ kind: "log", level: "warn" }] });
  });
});

describe("釣具屋", () => {
  it("釣具屋で竿を買うと、次に振ったときから、巻き上げのバーの当たり判定が広がる", async () => {
    const g = await boot("shop");
    await g.intro();
    for (let i = 0; i < 3; i++) await g.step("down");
    for (let i = 0; i < 6; i++) await g.step("right");
    await g.frames(press("up"), blank(), blank());
    expect(g.state().map.player).toMatchObject({ x: 18, y: 13, direction: "up" });
    await g.talk(() => g.state().scene.kind === "shop");
    // 購入：4 番目（ミミズ・エビ・ルアー・つりざお）を 1 つ
    await g.frames(press("ok"), blank());
    for (let i = 0; i < 3; i++) await g.tap("down");
    await g.tap("ok");
    await g.tap("ok");
    await g.tap("cancel");
    await g.tap("cancel");
    await g.talk(() => g.state().scene.kind === "map" && g.state().interpreters.length === 0, 30);
    expect(g.items()["item_rod1"]).toBe(1);
    expect(g.state().party.gold).toBe(0);
  });
});

describe("釣り大会", () => {
  /** 受付の前まで歩いて、話しかけて、「参加する」を選ぶ。 */
  async function enterTournament(g: Game): Promise<void> {
    for (let i = 0; i < 3; i++) await g.step("down");
    for (let i = 0; i < 7; i++) await g.step("left");
    await g.frames(press("up"), blank(), blank());
    expect(g.state().map.player).toMatchObject({ x: 5, y: 13, direction: "up" });
    await g.talk(() => g.state().message.choices !== null);
    await g.frames(press("ok"), blank(), blank()); // 1 つ目の選択肢（参加する）
    await g.talk(() => (g.state().switches as Record<string, boolean>)["sw_tournament"] === true && !g.state().message.open && g.state().interpreters.length === 0);
    await g.idle(2);
  }

  it("受付で申しこむと、100G を払って、点数 0・タイマー 2 分で大会が始まる。ミミズを 3 つもらう", async () => {
    const g = await boot("enter");
    await g.intro();
    await enterTournament(g);
    expect(g.state().party.gold).toBe(200);
    expect(g.items()["item_worm"]).toBe(11);
    expect(g.fishing()!.tournament).toEqual({ score: 0, catches: 0, biggest: null });
    expect(g.state().timers.active).toBe(true);
    expect(g.state().timers.ticks).toBeGreaterThan(7000);
    expect(g.texts()).toContain("釣り大会"); // 点数の表示
    expect(g.h.warnings).toEqual([]);
  });

  it("大会中に釣ると点数が入る。時間が来ると結果発表があり、順位・賞金・変数が決まる", async () => {
    const g = await boot("tournament");
    await g.intro();
    await enterTournament(g);
    // 桟橋に戻って、点数の入る魚（ながぐつ以外）を 1 匹釣るまで
    for (let i = 0; i < 7; i++) await g.step("right");
    await g.step("up");
    await g.step("up");
    await g.step("up");
    await g.step("up");
    await g.step("up");
    await g.frames(press("left"), blank(), blank());
    expect(g.state().map.player).toMatchObject({ x: 12, y: 8 });
    for (let tries = 0; tries < 6 && g.fishing()!.tournament!.catches === 0; tries++) {
      await castAndHook(g);
      await reelIn(g);
    }
    const t = g.fishing()!.tournament!;
    expect(t.catches).toBe(1);
    expect(g.state().timers.active).toBe(true);
    // 時間を進める（メニューの中は止まるので、マップで待つ）
    for (let i = 0; i < 9000 && g.state().timers.active; i++) await g.frames(blank());
    expect(g.state().timers.active).toBe(false);
    // 進行役が終わりを告げる → 結果発表の画面
    for (let i = 0; i < 300 && g.fishing()!.screen === null; i++) await g.talk(() => g.fishing()!.screen !== null, 1);
    expect(g.fishing()!.screen).toMatchObject({ kind: "result" });
    expect(g.texts()).toContain("けっか はっぴょう");
    await g.talk(() => g.fishing()!.screen === null, 3);
    await g.talk(() => (g.state().switches as Record<string, boolean>)["sw_tournament"] === false && !g.state().message.open && g.state().interpreters.every((i) => i.mode === "parallel"), 30);
    const v = g.vars();
    expect(v["var_fishing_rank"]).toBeGreaterThanOrEqual(1);
    expect(v["var_fishing_rank"]).toBeLessThanOrEqual(4);
    expect(v["var_fishing_score"]).toBe(t.score);
    expect(v["var_fishing_event"]).toBe(0);
    expect(g.fishing()!.tournament).toBeNull();
    expect((g.state().switches as Record<string, boolean>)["sw_tournament"]).toBe(false);
    expect(g.h.warnings).toEqual([]);
  });
});

describe("コマンド：結果発表", () => {
  const cfg = sampleConfig();
  const cmds = createCommands(() => ({ ok: true, config: cfg }));
  const result = cmds.find((c) => c.code === "Result")!;

  async function stateWith(score: number): Promise<GameState> {
    const g = await boot("result");
    const s = g.state();
    return { ...withFishing(s, { ...emptyFishing(), tournament: { score, catches: 3, biggest: null } }), timers: { active: false, ticks: 0 } };
  }
  const ctx = (state: GameState, ok = false): CommandCtx => ({ state, rng: rngOf(5), input: { pressed: new Set(ok ? ["ok"] : []), triggered: new Set(ok ? ["ok"] : []) } }) as unknown as CommandCtx;

  it("1 位：賞金とトロフィーをもらい、順位・点数・優勝回数の変数が決まる。画面を出して待ち、決定ボタンで閉じる", async () => {
    const s = await stateWith(10000);
    const r = result.run({}, ctx(s));
    expect(r.control).toEqual({ kind: "wait", wait: { kind: "plugin", name: "fishing" } });
    const after = r.state!;
    expect(after.party.gold).toBe(s.party.gold + 1000);
    expect(after.party.items["item_trophy" as never]).toBe(1);
    expect(after.variables).toMatchObject({ var_fishing_rank: 1, var_fishing_score: 10000, var_fishing_wins: 1 });
    const fs = fishingSchema.parse(after.pluginState!["fishing"]);
    expect(fs.tournament).toBeNull();
    expect(fs.screen).toMatchObject({ kind: "result", rank: 1, prize: 1000, trophy: true });
    expect(after.timers.active).toBe(false);
    // 決定ボタンを押すまで待つ
    expect(result.resume!({}, ctx(after)).control).toEqual({ kind: "wait", wait: { kind: "plugin", name: "fishing" } });
    const closed = result.resume!({}, ctx(after, true));
    expect(closed.control).toEqual({ kind: "next" });
    expect(fishingSchema.parse(closed.state!.pluginState!["fishing"]).screen).toBeNull();
  });

  it("賞金の無い順位：賞金なし・トロフィーなし・優勝回数は増えない", async () => {
    const s = await stateWith(0);
    const noPrize = createCommands(() => ({ ok: true, config: sampleConfig((p) => ({ ...p, tournament: { ...(p["tournament"] as object), prizes: [1000] } })) })).find((c) => c.code === "Result")!;
    const after = noPrize.run({}, ctx(s)).state!;
    expect(after.party.gold).toBe(s.party.gold);
    expect(after.party.items["item_trophy" as never]).toBeUndefined();
    expect(after.variables).toMatchObject({ var_fishing_rank: 3 });
    expect((after.variables as Record<string, number>)["var_fishing_wins"]).toBeUndefined();
  });

  it("大会に出ていないときは、何もしない", async () => {
    const g = await boot("none");
    expect(result.run({}, ctx(g.state()))).toEqual({});
  });
});

describe("図鑑", () => {
  it("魚拓の板に話しかけると、つり手帳が開く。決定ボタンで閉じる", async () => {
    const g = await boot("album");
    await g.intro();
    for (let i = 0; i < 3; i++) await g.step("down");
    for (let i = 0; i < 3; i++) await g.step("left");
    await g.frames(press("up"), blank(), blank());
    expect(g.state().map.player).toMatchObject({ x: 9, y: 13, direction: "up" });
    await g.talk(() => g.fishing()?.screen?.kind === "album");
    await g.idle(2);
    expect(g.texts()).toContain("つり手帳");
    expect(g.texts()).toContain("0 / 9 しゅるい");
    await g.frames(press("ok"), blank(), blank());
    expect(g.fishing()!.screen).toBeNull();
  });
});

describe("セーブとロード", () => {
  it("釣った記録（図鑑・持ち物・変数）は、セーブしてロードすると元どおり", async () => {
    const g = await boot("save");
    const registry = createPluginRegistry();
    await loadPlugins([fishingPlugin], registry, { params: { fishing: g.h.loaded.project.system.plugins[0]!.params } });
    const ext = toRuntimeExtensions(registry);
    const h = await createRuntimeHarness({ project: "fishing", projectVersion: 2, seed: "save", extensions: ext });
    const frames = async (...fs: ReturnType<typeof expandInputs>): Promise<void> => {
      for (const f of fs) {
        h.input.push(f);
        h.advanceFrames(1);
        if (h.runtime.status !== "running") await h.runtime.settled();
      }
    };
    const s0 = () => h.runtime.getState();
    for (let i = 0; i < 400 && (s0().switches as Record<string, boolean>)["sw_intro"] !== true; i++) await frames(press("ok"), blank(), blank());
    await frames(...expandInputs([{ wait: 5 }]));
    // 桟橋で釣る
    for (let i = 0; i < 2; i++) await frames(press("up"), ...Array.from({ length: 16 }, blank));
    await frames(press("left"), blank(), blank(), press("ok"), blank());
    const fish = () => (s0().pluginState?.["fishing"] as { cast: { phase: string; zone: number; zoneVel: number; pos: number } | null; album: object });
    for (let i = 0; i < 4000 && fish().cast?.phase !== "bite"; i++) await frames(blank());
    await frames(press("ok"));
    for (let i = 0; i < 6000 && fish().cast !== null; i++) {
      const c = fish().cast!;
      await frames(c.phase === "reel" ? (c.zone + c.zoneVel * 14 < c.pos ? hold("ok") : blank()) : c.phase === "done" ? press("ok") : blank());
    }
    await frames(...expandInputs([{ wait: 3 }]));
    expect(Object.keys(fish().album).length).toBe(1);
    const before = s0();
    // メニュー → セーブ（「セーブ」は 3 番目）→ スロット 1
    await frames(...expandInputs([{ press: "menu" }, { wait: 1 }, { press: "down" }, { wait: 1 }, { press: "down" }, { wait: 1 }, { press: "ok" }, { wait: 1 }, { press: "ok" }, { wait: 1 }]));
    await h.runtime.settled();
    expect((await h.saves.listSlots()).length).toBeGreaterThan(0);

    const loaded = await createRuntimeHarness({ project: "fishing", projectVersion: 2, seed: "other", title: true, extensions: ext, saves: h.saves });
    await loaded.runtime.settled();
    for (const f of expandInputs([{ press: "down" }, { wait: 1 }, { press: "ok" }, { wait: 1 }, { press: "ok" }, { wait: 5 }])) {
      loaded.input.push(f);
      loaded.advanceFrames(1);
      if (loaded.runtime.status !== "running") await loaded.runtime.settled();
    }
    await loaded.runtime.settled();
    const after = loaded.runtime.getState();
    expect(after.pluginState).toEqual(before.pluginState);
    expect(after.party.items).toEqual(before.party.items);
    expect(after.variables).toEqual(before.variables);
    expect(loaded.warnings).toEqual([]);
  });
});
