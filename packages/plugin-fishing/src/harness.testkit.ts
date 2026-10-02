// テスト専用：釣りのデモ（fixtures/projects/v2/fishing）をランタイムで動かすための道具。
import { createPluginRegistry, loadPlugins, selectPlugins, toRuntimeExtensions } from "@rpg/plugin-api";
import { createRuntimeHarness, expandInputs, loadFixtureProject } from "@rpg/test-utils";
import type { RuntimeHarness } from "@rpg/test-utils";
import { fishingPlugin } from "./index.js";
import { readFishing } from "./model.js";
import type { FishingState } from "./model.js";

type InputFrame = ReturnType<typeof expandInputs>[number];
export type Button = "up" | "down" | "left" | "right" | "ok" | "cancel" | "menu";
const press = (button: Button): InputFrame => expandInputs([{ press: button }])[0] as InputFrame;
const blank = (): InputFrame => expandInputs([{ wait: 1 }])[0] as InputFrame;
/** 押しっぱなしのフレーム（`pressed` だけ。`triggered` は付かない）。 */
const hold = (button: Button): InputFrame => ({ ...blank(), pressed: new Set([button]) }) as InputFrame;

export interface Game {
  h: RuntimeHarness;
  state(): ReturnType<RuntimeHarness["runtime"]["getState"]>;
  fishing(): FishingState | undefined;
  items(): Record<string, number>;
  vars(): Record<string, number>;
  /** 画面に出ている文字（メッセージ・HUD・ミニゲームの表示）。 */
  texts(): string[];
  /** 1 フレームずつ進める。 */
  frames(...inputs: InputFrame[]): Promise<void>;
  tap(button: Button): Promise<void>;
  idle(n: number): Promise<void>;
  /** 決定ボタンを押してメッセージを送る。`until` が真になるか、`max` 回で止まる。 */
  talk(until: () => boolean, max?: number): Promise<void>;
  /** 1 マス歩いて、動きが終わるまで進める。 */
  step(dir: "up" | "down" | "left" | "right"): Promise<void>;
  /** 最初の説明を聞いて、おこづかいをもらう。 */
  intro(): Promise<void>;
  /** 桟橋の (12, 8) に立って、左の水（桟橋の脇の釣り場）に向く。 */
  toPier(): Promise<void>;
  /** 桟橋の先の (12, 3) に立って、上の水（沖）に向く。 */
  toDeep(): Promise<void>;
  /** 巻き上げのバーを、魚に合わせて操作する（遅れなし）。 */
  follow(): InputFrame;
}

export async function boot(seed = "fishing", patch?: (params: Record<string, unknown>) => Record<string, unknown>): Promise<Game> {
  const project = loadFixtureProject("fishing", 2).project;
  const refs = project.system.plugins.map((p) => (p.name === "fishing" && patch !== undefined ? { ...p, params: patch({ ...p.params }) } : p));
  const selection = selectPlugins([fishingPlugin], refs);
  const registry = createPluginRegistry();
  const result = await loadPlugins(selection.modules, registry, { params: selection.params });
  if (result.failed.length > 0) throw new Error(String(result.failed[0]?.error));
  const h = await createRuntimeHarness({ project: "fishing", projectVersion: 2, seed, extensions: toRuntimeExtensions(registry) });
  const state = () => h.runtime.getState();
  const frames = async (...inputs: InputFrame[]): Promise<void> => {
    for (const input of inputs) {
      h.input.push(input);
      h.advanceFrames(1);
      if (h.runtime.status !== "running") await h.runtime.settled();
    }
  };
  const texts = (): string[] => {
    const walk = (n: { kind: string; text?: string; children?: readonly unknown[] }): string[] => (n.kind === "text" ? [n.text ?? ""] : ((n.children ?? []) as (typeof n)[]).flatMap(walk));
    return h.runtime.project().ui.flatMap((n) => walk(n as never));
  };
  const g: Game = {
    h,
    state,
    fishing: () => readFishing(state()),
    items: () => state().party.items as Record<string, number>,
    vars: () => state().variables as Record<string, number>,
    texts,
    frames,
    tap: (b) => frames(press(b), blank()),
    idle: (n) => frames(...Array.from({ length: n }, blank)),
    async talk(until, max = 200) {
      for (let i = 0; i < max && !until(); i++) await frames(press("ok"), blank(), blank());
    },
    async step(dir) {
      await frames(press(dir));
      for (let i = 0; i < 40 && state().map.player.moving; i++) await frames(blank());
    },
    async intro() {
      await g.talk(() => (state().switches as Record<string, boolean>)["sw_intro"] === true && !state().message.open);
      await g.idle(2);
    },
    async toPier() {
      await g.step("up");
      await g.step("up");
      await g.frames(press("left"), blank(), blank()); // 水は通れないので、向きだけ変わる
    },
    async toDeep() {
      for (let i = 0; i < 7; i++) await g.step("up");
      await g.frames(press("up"), blank(), blank());
    },
    follow() {
      const c = readFishing(state())?.cast;
      return c !== null && c !== undefined && c.zone + c.zoneVel * 14 < c.pos ? hold("ok") : blank();
    },
  };
  return g;
}

export { blank, hold, press };
