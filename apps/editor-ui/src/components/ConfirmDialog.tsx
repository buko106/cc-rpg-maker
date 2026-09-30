import type { ReactElement } from "react";
import type { Impact } from "@rpg/editor-core";
import { Dialog } from "./Dialog.js";

/** 参照が残っているものを削除しようとしたときの確認。影響範囲を見せて、強制するか選んでもらう。 */
export function ReferencesDialog({ what, references, onForce, onCancel }: { what: string; references: readonly Impact[]; onForce: () => void; onCancel: () => void }): ReactElement {
  return (
    <Dialog title="削除の確認" onClose={onCancel}>
      <p>
        {what} はまだ使われています（{references.length} 件）。削除すると、これらは参照切れになります。
      </p>
      <ul className="impact-list">
        {references.slice(0, 50).map((r, i) => (
          <li key={i}>{r.description}</li>
        ))}
        {references.length > 50 && <li>ほか {references.length - 50} 件</li>}
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          キャンセル
        </button>
        <button type="button" className="danger" onClick={onForce}>
          それでも削除
        </button>
      </div>
    </Dialog>
  );
}

/** 単純な確認。 */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }): ReactElement {
  return (
    <Dialog title={title} onClose={onCancel}>
      <p>{message}</p>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          キャンセル
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
