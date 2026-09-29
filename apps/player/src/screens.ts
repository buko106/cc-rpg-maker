/** ローディング画面とエラー画面（ゲーム画面の上に重ねる素朴な DOM）。 */
export interface Screens {
  loading(message: string): void;
  error(error: unknown, debug: boolean): void;
  hide(): void;
}

export function createScreens(root: HTMLElement): Screens {
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "status");
  overlay.style.cssText =
    "position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:8px;" +
    "background:rgba(0,0,0,0.85);color:#fff;font:16px sans-serif;text-align:center;padding:16px;white-space:pre-wrap;";
  root.append(overlay);

  const show = (text: string, kind: "loading" | "error"): void => {
    overlay.dataset["screen"] = kind;
    overlay.setAttribute("role", kind === "error" ? "alert" : "status");
    overlay.style.color = kind === "error" ? "#ffb4b4" : "#fff";
    overlay.textContent = text;
    overlay.style.display = "flex";
  };

  return {
    loading: (message) => show(message, "loading"),
    error(error, debug) {
      const e = error instanceof Error ? error : new Error(String(error));
      show(`エラーが発生しました\n${e.message}${debug && e.stack ? `\n\n${e.stack}` : ""}`, "error");
    },
    hide() {
      overlay.style.display = "none";
      delete overlay.dataset["screen"];
    },
  };
}
