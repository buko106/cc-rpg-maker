// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { AssetSource, FrameSpec, ImageHandle } from "@rpg/runtime";
import { rendererContract } from "@rpg/test-utils";
import { createDomRenderer } from "./index.js";

const img = (width: number, height: number): ImageHandle => ({ width, height }) as unknown as ImageHandle;
const imageUrl = (): Promise<string> => Promise.resolve("img.png");
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function assetsOf(images: Record<string, ImageHandle>) {
  const loads: string[] = [];
  const source: AssetSource = {
    loadImage: (id) => {
      loads.push(id);
      const h = images[id];
      return h === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(h);
    },
    loadAudio: () => Promise.reject(new Error("n/a")),
    loadJson: () => Promise.reject(new Error("n/a")),
    has: (id) => Promise.resolve(id in images),
  };
  return { source, loads };
}

const frame = (over: Partial<FrameSpec> = {}): FrameSpec => ({
  size: { width: 64, height: 48 },
  camera: { x: 0, y: 0 },
  layers: [],
  overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } },
  ui: [],
  ...over,
});

const white = { r: 255, g: 255, b: 255, a: 1 };
const visible = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>("div")].filter((d) => d.style.display !== "none");

rendererContract("dom (jsdom)", () => createDomRenderer(document.createElement("div"), { imageUrl }));

describe("createDomRenderer", () => {
  it("init で root の大きさと data-renderer を決める。resize で変わる", async () => {
    const root = document.createElement("div");
    const r = createDomRenderer(root, { imageUrl });
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    expect([root.style.width, root.style.height, root.dataset["renderer"]]).toEqual(["64px", "48px", "dom"]);
    r.resize(10, 20);
    expect([root.style.width, root.style.height]).toEqual(["10px", "20px"]);
  });

  it("未ロードの画像は描かず、ロード後の次のフレームから、見えているタイルだけ描く", async () => {
    const root = document.createElement("div");
    const { source, loads } = assetsOf({ aaaaaaaaaaaaaaaa: img(64, 64) });
    const r = createDomRenderer(root, { imageUrl });
    await r.init({ width: 32, height: 16, assets: source });
    // 4x1 のうち、カメラ x=16 で見えるのは 1・2 番目のセル
    const f = frame({ size: { width: 32, height: 16 }, camera: { x: 16, y: 0 }, layers: [{ kind: "tiles", tileset: "aaaaaaaaaaaaaaaa" as never, tileSize: 16, width: 4, height: 1, tiles: [1, 2, 3, 5], z: 0 }] });

    r.render(f);
    expect(root.querySelectorAll("[style*=background]").length).toBe(0);
    r.render(f);
    expect(loads).toEqual(["aaaaaaaaaaaaaaaa"]);
    await flush();
    r.render(f);
    const cells = [...root.querySelectorAll<HTMLElement>("[style*=background]")].filter((d) => d.style.display !== "none");
    // x=16..47 が見える範囲 → 2 番目（x=16）と 3 番目（x=32）のセルだけ
    expect(cells.map((c) => c.style.left)).toEqual(["16px", "32px"]);
    expect(cells[0]!.style.backgroundPosition).toBe("-32px 0px");
    expect(root.firstElementChild instanceof HTMLElement && (root.firstElementChild as HTMLElement).style.transform).toBe("translate(-16px,0px)");
  });

  it("スプライトは並び順を保ち、flipX と alpha を反映する", async () => {
    const root = document.createElement("div");
    const { source } = assetsOf({ bbbbbbbbbbbbbbbb: img(32, 32) });
    const r = createDomRenderer(root, { imageUrl });
    await r.init({ width: 64, height: 48, assets: source });
    const sprite = (x: number, extra = {}) => ({ asset: "bbbbbbbbbbbbbbbb" as never, sx: 16, sy: 0, sw: 16, sh: 16, x, y: 4, ...extra });
    const f = frame({ layers: [{ kind: "sprites", z: 0, sprites: [sprite(1), sprite(2, { alpha: 0.5, flipX: true })] }] });
    r.render(f);
    await flush();
    r.render(f);
    const els = [...root.querySelectorAll<HTMLElement>("[style*=background]")];
    expect(els.map((e) => e.style.left)).toEqual(["1px", "2px"]);
    expect(els[1]!.style.transform).toBe("scaleX(-1)");
    expect(els[1]!.style.opacity).toBe("0.5");
  });

  it("UI: window・text・gauge・cursor を作り、同じ内容なら作り直さない", async () => {
    const root = document.createElement("div");
    const r = createDomRenderer(root, { imageUrl });
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    const f = frame({
      ui: [
        {
          kind: "window",
          x: 2,
          y: 2,
          w: 60,
          h: 30,
          children: [
            { kind: "text", x: 4, y: 4, text: "こんにちは", font: { family: "sans-serif", size: 12 }, color: white, maxWidth: 40 },
            { kind: "text", x: 4, y: 18, text: "ab", font: { family: "sans-serif", size: 12 }, color: white, runs: [{ text: "a", color: white }, { text: "b", color: { ...white, r: 0 } }] },
            { kind: "gauge", x: 4, y: 26, w: 20, h: 4, ratio: 0.5, color: white },
            { kind: "cursor", x: 30, y: 4, w: 10, h: 10, blink: false },
          ],
        },
      ],
    });
    r.render(f);
    const ui = root.querySelector<HTMLElement>("[aria-live]")!;
    expect(ui.textContent).toBe("こんにちはab");
    expect(ui.querySelectorAll("[role=group]").length).toBe(1);
    expect(ui.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("50");
    expect(ui.querySelectorAll("[data-cursor]").length).toBe(1);
    expect(ui.querySelectorAll("span").length).toBe(2);
    const first = ui.firstElementChild;
    r.render({ ...f }); // 同じ内容
    expect(ui.firstElementChild).toBe(first);
    r.render(frame());
    expect(ui.childElementCount).toBe(0);
  });

  it("overlay は tint → flash → fade の順で、使わないものは隠す", async () => {
    const root = document.createElement("div");
    const r = createDomRenderer(root, { imageUrl });
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    r.render(frame({ overlay: { fade: 0.25, tint: { r: 0, g: 0, b: 64, a: 0.2 }, flash: { color: white, alpha: 0.5 }, shake: { dx: 0, dy: 0 } } }));
    const covers = [...root.children].slice(1, 4) as HTMLElement[];
    expect(covers.map((c) => c.style.display)).toEqual(["", "", ""]);
    expect(covers[0]!.style.background).toContain("0, 0, 64");
    r.render(frame());
    expect(covers.map((c) => c.style.display)).toEqual(["none", "none", "none"]);
    expect(visible(root).length).toBeGreaterThan(0);
  });

  it("dispose で root を空にし、その後の render は何もしない", async () => {
    const root = document.createElement("div");
    const r = createDomRenderer(root, { imageUrl });
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    r.dispose();
    expect(root.childElementCount).toBe(0);
    r.render(frame({ ui: [{ kind: "gauge", x: 0, y: 0, w: 1, h: 1, ratio: 1, color: white }] }));
    expect(root.childElementCount).toBe(0);
  });
});
