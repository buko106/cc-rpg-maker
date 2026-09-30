import type { ProjectDocument, ProjectMeta, ProjectRepository } from "@rpg/project-store";
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";

/** プロジェクトの一覧：新規作成、開く、削除。 */
export function ProjectList({ repo, onOpen }: { repo: ProjectRepository; onOpen: (doc: ProjectDocument) => void }): ReactElement {
  const [projects, setProjects] = useState<ProjectMeta[] | undefined>();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState<ProjectMeta | undefined>();

  const refresh = useCallback(() => {
    repo.list().then(setProjects, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [repo]);
  useEffect(refresh, [refresh]);

  const open = async (id: string): Promise<void> => {
    const r = await repo.load(id);
    if (r.ok) onOpen(r.value);
    else setError(`プロジェクトを開けません（${r.error.kind}）`);
  };

  return (
    <main className="project-list">
      <h1>cc-rpg-maker</h1>
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          repo.create(title.trim() === "" ? "新しいゲーム" : title.trim()).then(onOpen, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        <input type="text" aria-label="新しいプロジェクトの名前" placeholder="ゲームのタイトル" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit" className="primary">
          新規作成
        </button>
      </form>
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      <h2>プロジェクト</h2>
      {projects === undefined ? (
        <p className="muted">読み込み中…</p>
      ) : projects.length === 0 ? (
        <p className="muted">まだプロジェクトがありません。上のフォームから作ってください。</p>
      ) : (
        <ul aria-label="プロジェクト一覧" className="projects">
          {projects.map((p) => (
            <li key={p.id}>
              <span className="project-title">{p.title}</span>
              <span className="muted">{new Date(p.updatedAt).toLocaleString("ja-JP")}</span>
              <button type="button" onClick={() => void open(p.id)} aria-label={`${p.title} を開く`}>
                開く
              </button>
              <button type="button" onClick={() => setDeleting(p)} aria-label={`${p.title} を削除`}>
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
      {deleting !== undefined && (
        <ConfirmDialog
          title="プロジェクトの削除"
          message={`「${deleting.title}」を削除します。元に戻せません。`}
          confirmLabel="削除する"
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(undefined);
            repo.remove(id).then(refresh, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
          }}
        />
      )}
    </main>
  );
}
