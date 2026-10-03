// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createTouchInput } from "./touch.js";
import { isCoarsePointer, mountTouchPad } from "./touch-pad.js";

// jsdom には PointerEvent も、ポインタのキャプチャも無い。座標つきのポインタイベントを送れるように、MouseEvent を元に用意する。
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
(globalThis as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
HTMLElement.prototype.setPointerCapture = () => {};

const control = (root: HTMLElement, name: string): HTMLElement => root.querySelector<HTMLElement>(`[data-control="${name}"]`)!;
const fire = (el: HTMLElement, type: string, init: PointerEventInit = {}): void => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init }));

afterEach(() => {
  document.body.replaceChildren();
});

describe("mountTouchPad", () => {
  it("十字キー・A・B・メニューを出す。走るボタンは dash のときだけ", () => {
    const plain = mountTouchPad(document.body, createTouchInput());
    expect([...document.querySelectorAll("[data-control]")].map((e) => (e as HTMLElement).dataset["control"]).sort()).toEqual(["cancel", "dpad", "menu", "ok"]);
    plain.dispose();
    const dash = mountTouchPad(document.body, createTouchInput(), { dash: true });
    expect(control(dash.element, "shift")).toBeTruthy();
    dash.dispose();
  });

  it("ボタンを押している間だけ押下になり、離すと戻る。押下状態を data-pressed に出す", () => {
    const input = createTouchInput();
    const view = mountTouchPad(document.body, input);
    const ok = control(view.element, "ok");
    expect(ok.dataset["pressed"]).toBe("false");
    fire(ok, "pointerdown", { clientX: 0, clientY: 0 });
    expect(ok.dataset["pressed"]).toBe("true");
    expect(input.held().has("ok")).toBe(true);
    fire(ok, "pointerup");
    expect(ok.dataset["pressed"]).toBe("false");
    expect(input.held().has("ok")).toBe(false);
    view.dispose();
  });

  it("十字キーは触った位置の方向を押す（要素の中心からの位置）", () => {
    const input = createTouchInput();
    const view = mountTouchPad(document.body, input);
    const dpad = control(view.element, "dpad");
    fire(dpad, "pointerdown", { clientX: 60, clientY: 0 });
    expect(input.held().has("right")).toBe(true);
    expect(dpad.dataset["pressed"]).toBe("true");
    fire(dpad, "pointermove", { clientX: 0, clientY: -60 });
    expect(input.held().has("up")).toBe(true);
    expect(input.held().has("right")).toBe(false);
    fire(dpad, "pointercancel");
    expect(dpad.dataset["pressed"]).toBe("false");
    view.dispose();
  });

  it("dispose で操作パッドを外し、押しているものを離す", () => {
    const input = createTouchInput();
    const view = mountTouchPad(document.body, input);
    fire(control(view.element, "ok"), "pointerdown");
    view.dispose();
    expect(document.querySelector("[data-touch-pad]")).toBeNull();
    expect(input.held().size).toBe(0);
  });
});

describe("isCoarsePointer", () => {
  it("matchMedia の (pointer: coarse) を見る。matchMedia が無ければ false", () => {
    const original = window.matchMedia;
    try {
      window.matchMedia = undefined as never;
      expect(isCoarsePointer()).toBe(false);
      window.matchMedia = ((q: string) => ({ matches: q === "(pointer: coarse)" }) as MediaQueryList) as typeof window.matchMedia;
      expect(isCoarsePointer()).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });
});
