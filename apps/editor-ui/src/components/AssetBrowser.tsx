import { cmd } from "@rpg/editor-core";
import type { AssetEntry, AssetId } from "@rpg/schema";
import { useState } from "react";
import type { DragEvent, ReactElement } from "react";
import { useSession } from "../hooks.js";
import { Dialog } from "./Dialog.js";
import { useAssetUrl } from "./useAssetUrl.js";
import { useExecute } from "./useExecute.js";

const kindOf = (file: File): AssetEntry["kind"] | undefined => {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (/\.(ttf|otf|woff2?)$/i.test(file.name)) return "font";
  if (file.type === "application/json") return "data";
  return undefined;
};

const formatSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function Thumb({ id, entry }: { id: AssetId; entry: AssetEntry }): ReactElement {
  const url = useAssetUrl(entry.kind === "image" ? id : undefined);
  return url === undefined ? <span className="thumb thumb-empty" aria-hidden="true">{entry.kind === "audio" ? "♪" : "▫"}</span> : <img className="thumb" src={url} alt="" />;
}

/** アセット一覧。ファイルの選択またはドロップで取り込み、不要なものは登録を外す（使用中なら確認）。 */
export function AssetBrowser({ onClose }: { onClose: () => void }): ReactElement {
  const session = useSession();
  const { run, dialog, error } = useExecute((c) => c.label);
  const [message, setMessage] = useState<string | undefined>();
  const [over, setOver] = useState(false);
  const entries = Object.entries(session.doc.project.assets.entries) as [AssetId, AssetEntry][];

  const importFiles = async (files: readonly File[]): Promise<void> => {
    const notes: string[] = [];
    for (const file of files) {
      const kind = kindOf(file);
      if (kind === undefined) {
        notes.push(`${file.name}：対応していない形式`);
        continue;
      }
      const r = await session.importAsset(await file.arrayBuffer(), file.name, kind);
      notes.push(r.ok ? `${file.name}：取り込みました` : `${file.name}：${r.error.message}`);
    }
    setMessage(notes.join(" / "));
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setOver(false);
    void importFiles([...e.dataTransfer.files]);
  };

  return (
    <Dialog title="アセット" onClose={onClose} wide>
      <div
        className={over ? "dropzone over" : "dropzone"}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <label>
          ファイルを選ぶか、ここにドロップ（画像・音声・フォント・JSON）
          <input type="file" multiple accept="image/*,audio/*,.ttf,.otf,.woff,.woff2,application/json" aria-label="アセットのファイル" onChange={(e) => void importFiles([...(e.target.files ?? [])])} />
        </label>
      </div>
      {message !== undefined && <p role="status">{message}</p>}
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      <ul className="asset-list" aria-label="アセット一覧">
        {entries.map(([id, entry]) => (
          <li key={id}>
            <Thumb id={id} entry={entry} />
            <span className="asset-name">{entry.name}</span>
            <span className="muted">
              {entry.kind}
              {entry.width !== undefined && entry.height !== undefined ? ` ${entry.width}×${entry.height}` : ""} · {formatSize(entry.size)}
            </span>
            <code className="muted">{id}</code>
            <button type="button" aria-label={`${entry.name} の登録を外す`} onClick={() => run(cmd.unregisterAsset(id))}>
              削除
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className="empty">（アセットなし）</li>}
      </ul>
      {dialog}
    </Dialog>
  );
}
