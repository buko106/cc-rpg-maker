import { exportGame } from "@rpg/exporter";
import type { ExportOptions } from "@rpg/exporter";
import { useState } from "react";
import type { ReactElement } from "react";
import { useEnv, useRepo, useSession } from "../hooks.js";
import { Dialog } from "./Dialog.js";

type Format = ExportOptions["format"];
type Outcome = { kind: "done"; fileName: string; size: number; warnings: string[] } | { kind: "error"; message: string };

const formatSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * 配布物の書き出し：形式（フォルダ形式の ZIP / 単一 HTML）を選んで、ファイルとして保存する。
 * 保存済みの内容から作るので、書き出す前に未保存の変更を保存する（保存できなければ書き出さない）。
 */
export function ExportDialog({ onClose }: { onClose: () => void }): ReactElement {
  const env = useEnv();
  const repo = useRepo();
  const session = useSession();
  const [format, setFormat] = useState<Format>("folder");
  const [minify, setMinify] = useState(true);
  const [renderer, setRenderer] = useState<NonNullable<ExportOptions["renderer"]>>("auto");
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>();

  const run = async (): Promise<void> => {
    setBusy(true);
    setOutcome(undefined);
    try {
      const saved = await session.save();
      if (!saved.ok) {
        setOutcome({ kind: "error", message: `先に保存できなかったので書き出せません（${saved.error.kind}）。保存状態を確認してください。` });
        return;
      }
      const player = await env.loadPlayerBundle();
      const r = await exportGame(repo, session.doc.project.meta.id, { format, minifyJson: minify, renderer, offline: offline && format === "folder" }, player);
      if (!r.ok) {
        setOutcome({ kind: "error", message: `書き出せませんでした（${r.error.kind}）` });
        return;
      }
      env.saveFile(r.value.fileName, r.value.bytes, r.value.mime);
      setOutcome({ kind: "done", fileName: r.value.fileName, size: r.value.bytes.length, warnings: r.value.warnings });
    } catch (e) {
      setOutcome({ kind: "error", message: `書き出せませんでした：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="配布物の書き出し" onClose={onClose}>
      <div role="radiogroup" aria-label="形式" className="export-formats">
        <label className="check">
          <input type="radio" name="export-format" checked={format === "folder"} onChange={() => setFormat("folder")} />
          フォルダ形式（ZIP）
        </label>
        <p className="muted">静的ファイルを置けるサーバ（GitHub Pages など）に、ZIP の中身をそのまま置きます。</p>
        <label className="check">
          <input type="radio" name="export-format" checked={format === "singleHtml"} onChange={() => setFormat("singleHtml")} />
          単一 HTML
        </label>
        <p className="muted">すべてを 1 つの HTML に入れます。メールなどで配れますが、大きなゲームには向きません。</p>
      </div>
      <label className="check">
        <input type="checkbox" checked={minify} onChange={(e) => setMinify(e.target.checked)} />
        JSON を圧縮する（小さくなります）
      </label>
      <label className="check">
        <input type="checkbox" checked={offline && format === "folder"} disabled={format !== "folder"} onChange={(e) => setOffline(e.target.checked)} />
        オフラインでも遊べるようにする（フォルダ形式のみ。2 回目以降）
      </label>
      <label className="check">
        描画方式
        <select aria-label="描画方式" value={renderer} onChange={(e) => setRenderer(e.target.value as typeof renderer)}>
          <option value="auto">自動（WebGL が使えれば WebGL）</option>
          <option value="webgl">WebGL</option>
          <option value="canvas2d">Canvas2D</option>
        </select>
      </label>
      {outcome?.kind === "error" && (
        <p role="alert" className="notice error">
          {outcome.message}
        </p>
      )}
      {outcome?.kind === "done" && (
        <div role="status" className="notice">
          <p>
            「{outcome.fileName}」を書き出しました（{formatSize(outcome.size)}）。
          </p>
          {outcome.warnings.length > 0 && (
            <ul aria-label="注意">
              {outcome.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          閉じる
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? "書き出し中…" : "書き出す"}
        </button>
      </div>
    </Dialog>
  );
}
