import { useCallback, useState } from "react";
import type { ReactElement } from "react";
import type { EditError, EditorCommand } from "@rpg/editor-core";
import { useSession } from "../hooks.js";
import { ReferencesDialog } from "./ConfirmDialog.js";

/**
 * コマンドを実行する。削除で参照が残っていれば確認ダイアログを出し、承諾されたら強制実行する。
 * それ以外の失敗は `notice`（画面のお知らせ）に出す。
 */
export function useExecute(what?: (c: EditorCommand) => string): { run: (c: EditorCommand) => boolean; dialog: ReactElement | null; error: string | undefined; clearError: () => void } {
  const session = useSession();
  const [pending, setPending] = useState<{ command: EditorCommand; error: Extract<EditError, { kind: "hasReferences" }> } | undefined>();
  const [error, setError] = useState<string | undefined>();

  const run = useCallback(
    (c: EditorCommand): boolean => {
      const r = session.execute(c);
      if (r.ok) {
        setError(undefined);
        return true;
      }
      if (r.error.kind === "hasReferences") setPending({ command: c, error: r.error });
      else setError(r.error.message);
      return false;
    },
    [session],
  );

  const dialog =
    pending === undefined ? null : (
      <ReferencesDialog
        what={what?.(pending.command) ?? pending.command.label}
        references={pending.error.references}
        onCancel={() => setPending(undefined)}
        onForce={() => {
          session.execute(pending.command, { force: true });
          setPending(undefined);
        }}
      />
    );
  return { run, dialog, error, clearError: () => setError(undefined) };
}
