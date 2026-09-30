import { createEditorSession } from "@rpg/editor-core";
import type { EditorSession } from "@rpg/editor-core";
import type { ProjectDocument, ProjectRepository } from "@rpg/project-store";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ProjectList } from "./components/ProjectList.js";
import { Shell } from "./components/Shell.js";
import { EnvContext, RepoContext, SessionContext } from "./hooks.js";
import type { EditorEnv } from "./hooks.js";

/** 自動保存までの待ち時間。 */
export const AUTOSAVE_MS = 1000;

export interface AppProps {
  env: EditorEnv;
  repo: ProjectRepository;
}

/** ルート：プロジェクト一覧 ↔ エディタ。 */
export function App({ env, repo }: AppProps): ReactElement {
  const [session, setSession] = useState<EditorSession | undefined>();

  // セッションを閉じるときは、自動保存のタイマーを止めて、未保存の分を保存する
  useEffect(
    () => () => {
      session?.dispose();
    },
    [session],
  );

  const open = (doc: ProjectDocument): void => {
    const next = createEditorSession({ repo, doc, commands: env.commands, autosave: { debounceMs: AUTOSAVE_MS } });
    (window as unknown as { __editor?: EditorSession }).__editor = next; // E2E とデバッグ用
    setSession(next);
  };

  const exit = (): void => {
    if (session === undefined) return;
    // 保存できなかったときは（競合など）閉じずに、画面の保存状態を見てもらう
    void session.save().then((r) => r.ok && setSession(undefined));
  };

  return (
    <EnvContext.Provider value={env}>
      <RepoContext.Provider value={repo}>
        {session === undefined ? (
          <ProjectList repo={repo} onOpen={open} />
        ) : (
          <SessionContext.Provider value={session}>
            <Shell onExit={exit} />
          </SessionContext.Provider>
        )}
      </RepoContext.Provider>
    </EnvContext.Provider>
  );
}
