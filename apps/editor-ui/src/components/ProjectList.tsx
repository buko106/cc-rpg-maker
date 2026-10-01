import type { ProjectDocument, ProjectMeta, ProjectRepository, ProjectStoreError } from "@rpg/project-store";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useEnv } from "../hooks.js";
import type { ProjectSample } from "../hooks.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

/** 取り込めなかった理由（ZIP の中身の問題なら、最初の 1 つを添える）。 */
function describeImportError(e: ProjectStoreError): string {
  if (e.kind !== "schema") return e.kind;
  const s = e.error;
  if (s.kind === "invalid") return s.issues[0] === undefined ? "schema" : `${s.issues[0].path}: ${s.issues[0].message}`;
  if (s.kind === "newer-format") return `このエディタより新しい形式（${s.found}）です`;
  return s.message;
}

/** ZIP のファイル名に使えない文字を除く。 */
const zipName = (title: string): string => `${title.replace(/[\\/:*?"<>|]/g, "_").trim() || "project"}.zip`;

/** プロジェクトの一覧：新規作成、サンプルから作る、ZIP の読み込み、開く、ZIP に書き出す、削除。 */
export function ProjectList({
  repo,
  onOpen,
  storageLabel,
  onPickFolder,
}: {
  repo: ProjectRepository;
  onOpen: (doc: ProjectDocument) => void;
  /** いまの保存先の名前。 */
  storageLabel?: string;
  /** 保存先のフォルダを選び直す。選ぶのをやめたとき（AbortError）は何も起きない。 */
  onPickFolder?: () => Promise<void>;
}): ReactElement {
  const [projects, setProjects] = useState<ProjectMeta[] | undefined>();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState<ProjectMeta | undefined>();
  const env = useEnv();
  const [samples, setSamples] = useState<readonly ProjectSample[]>([]);
  /** 取り込み中（サンプルの id か "zip"）。その間はほかの取り込みを押せない。 */
  const [importing, setImporting] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    repo.list().then(setProjects, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [repo]);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    let alive = true;
    env.listSamples().then(
      (list) => alive && setSamples(list),
      (e: unknown) => alive && setError(`サンプルの一覧を読めません（${e instanceof Error ? e.message : String(e)}）`),
    );
    return () => {
      alive = false;
    };
  }, [env]);

  const open = async (id: string): Promise<void> => {
    const r = await repo.load(id);
    if (r.ok) onOpen(r.value);
    else setError(`プロジェクトを開けません（${r.error.kind}）`);
  };

  /** ZIP（サンプル・利用者のファイル）を新しいプロジェクトとして取り込んで開く。 */
  const importFrom = async (key: string, bytes: () => Promise<Uint8Array | ArrayBuffer>): Promise<void> => {
    setError(undefined);
    setImporting(key);
    try {
      const r = await repo.importZip(await bytes());
      if (r.ok) await open(r.value.id);
      else {
        setError(`読み込めません（${describeImportError(r.error)}）`);
        refresh();
      }
    } catch (e) {
      setError(`読み込めません（${e instanceof Error ? e.message : String(e)}）`);
    } finally {
      setImporting(undefined);
    }
  };

  const exportZip = async (p: ProjectMeta): Promise<void> => {
    setError(undefined);
    const r = await repo.exportZip(p.id);
    if (r.ok) env.saveFile(zipName(p.title), r.value, "application/zip");
    else setError(`書き出せません（${r.error.kind}）`);
  };

  return (
    <main className="project-list">
      <h1>cc-rpg-maker</h1>
      {storageLabel !== undefined && (
        <p className="storage muted">
          保存先：<strong>{storageLabel}</strong>
          {onPickFolder !== undefined && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => {
                  setError(undefined);
                  onPickFolder().catch((e: unknown) => {
                    if (e instanceof DOMException && e.name === "AbortError") return; // 選ぶのをやめた
                    setError(e instanceof Error ? e.message : String(e));
                  });
                }}
              >
                フォルダを選ぶ…
              </button>
            </>
          )}
        </p>
      )}
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
      <p className="import-zip">
        <button type="button" disabled={importing !== undefined} onClick={() => fileInput.current?.click()}>
          {importing === "zip" ? "読み込み中…" : "ZIP から読み込む…"}
        </button>
        <span className="muted">「ZIP」で書き出したプロジェクトを、新しいプロジェクトとして取り込みます。</span>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          aria-label="読み込む ZIP ファイル"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // 同じファイルをもう一度選べるように
            if (file !== undefined) void importFrom("zip", () => file.arrayBuffer());
          }}
        />
      </p>
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      {samples.length > 0 && (
        <section aria-labelledby="samples-heading">
          <h2 id="samples-heading">サンプルから作る</h2>
          <p className="muted">デモのゲームの編集データを、新しいプロジェクトとして取り込みます。中身を見たり、作り変えたりできます。</p>
          <ul aria-label="サンプル" className="samples">
            {samples.map((s) => (
              <li key={s.id}>
                {s.imageUrl !== undefined && <img src={s.imageUrl} alt="" />}
                <div className="sample-body">
                  <strong>{s.title}</strong>
                  <span className="muted">{s.description}</span>
                  {s.tags.length > 0 && (
                    <span className="tags">
                      {s.tags.map((t) => (
                        <span key={t}>{t}</span>
                      ))}
                    </span>
                  )}
                  <button type="button" className="primary" disabled={importing !== undefined} onClick={() => void importFrom(s.id, () => env.loadSample(s.id))} aria-label={`${s.title} のサンプルから作る`}>
                    {importing === s.id ? "読み込み中…" : "このサンプルから作る"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
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
              <button type="button" onClick={() => void exportZip(p)} aria-label={`${p.title} を ZIP に書き出す`} title="編集データ（project.json・マップ・アセット）を ZIP で保存する">
                ZIP
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
