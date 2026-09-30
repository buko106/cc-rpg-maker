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

/** プロジェクトの保存先（ProjectRepository と、画面に出す名前）。 */
export interface Storage {
  repo: ProjectRepository;
  label: string;
}

export interface AppProps {
  env: EditorEnv;
  repo: ProjectRepository;
  /** 一覧に出す、いまの保存先の名前。 */
  storageLabel?: string;
  /** 保存先のフォルダを利用者に選ばせる（呼ぶのはクリックの中。選ばずに閉じたら reject してよい）。無ければ切り替えボタンを出さない。 */
  pickFolder?: () => Promise<Storage>;
}

/** ルート：プロジェクト一覧 ↔ エディタ。 */
export function App({ env, repo: initialRepo, storageLabel = "ブラウザ内", pickFolder }: AppProps): ReactElement {
  const [storage, setStorage] = useState<Storage>({ repo: initialRepo, label: storageLabel });
  const repo = storage.repo;
  const [session, setSession] = useState<EditorSession | undefined>();

  // セッションを閉じるときは、自動保存のタイマーを止めて、未保存の分を保存する
  useEffect(
    () => () => {
      session?.dispose();
    },
    [session],
  );

  const open = (doc: ProjectDocument): void => {
    const next = createEditorSession({ repo, doc, commands: env.commands, diagnostics: env.pluginDiagnostics, autosave: { debounceMs: AUTOSAVE_MS } });
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
          <ProjectList repo={repo} onOpen={open} storageLabel={storage.label} {...(pickFolder === undefined ? {} : { onPickFolder: () => pickFolder().then(setStorage) })} />
        ) : (
          <SessionContext.Provider value={session}>
            <Shell onExit={exit} />
          </SessionContext.Provider>
        )}
      </RepoContext.Provider>
    </EnvContext.Provider>
  );
}
