import { useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode } from "react";

/**
 * モーダルなダイアログ。Esc で閉じ、開いたら中の最初の操作可能な要素にフォーカスする。
 * `<dialog>` 要素は jsdom で未対応の部分があるので、role="dialog" の div で作る。
 */
export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }): ReactElement {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])")?.focus();
    return () => previous?.focus?.();
  }, []);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={wide ? "dialog dialog-wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" data-close aria-label={`${title}を閉じる`} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
