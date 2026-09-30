import { extensionOf, writeZip } from "@rpg/project-store";
import type { ProjectRepository, ProjectStoreError, ZipFile } from "@rpg/project-store";
import { ok, serializeMapData, serializeProject } from "@rpg/schema";
import type { Result } from "@rpg/schema";
import { renderServiceWorker, SW_FILE } from "./service-worker.js";
import { README_TEXT, renderIndexHtml, renderSingleHtml } from "./templates.js";
import type { EmbeddedGame, RendererKind } from "./templates.js";

export type { RendererKind } from "./templates.js";

export interface ExportOptions {
  format: "folder" | "singleHtml";
  /** 描画方式。`auto`（既定）は WebGL が使えれば WebGL、使えなければ Canvas2D。 */
  renderer?: RendererKind;
  /** フォルダ形式だけ：Service Worker（`sw.js`）を同梱して、2 回目以降はオフラインでも遊べるようにする。 */
  offline?: boolean;
  /** `false` なら JSON を整形して書き出す（人が読むとき用）。既定は圧縮（`true`）。 */
  minifyJson?: boolean;
  /** 単一 HTML がこの大きさ（バイト）を超えたら警告する。既定は 16 MB。 */
  warnAboveBytes?: number;
}

/** プレイヤーの実装（`apps/player` をバンドルした `player.js`）。エクスポータはこれをそのまま同梱する。 */
export interface PlayerBundle {
  js: string;
}

export interface ExportedGame {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  /** 保存するときのファイル名（拡張子つき）。 */
  fileName: string;
  /** 利用者に知らせたいこと（単一 HTML が大きいなど）。 */
  warnings: string[];
}

/** 単一 HTML がこれを超えたら、フォルダ形式をすすめる警告を出す。 */
export const SINGLE_HTML_WARN_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();

/** `</script>` や `<!--` でスクリプトが途切れないように、JS のソースを埋め込める形にする。 */
export function escapeForScript(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** `<script type="application/json">` に埋め込める JSON（`<` と行区切り文字をエスケープ）。 */
export function escapeJsonForScript(json: string): string {
  return json.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** バイト列 → base64（大きなものでも呼び出しスタックを溢れさせないよう、分けて変換する）。 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** タイトル → ファイル名に使える文字列。 */
function slug(title: string): string {
  const s = title.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return s === "" ? "game" : s;
}

/** フォルダ形式のアセットのファイル名（プレイヤーの `createHttpBytesSource` と同じ規則）。 */
const assetFileName = (id: string, entry: { name: string; mime: string }): string => `${id}${extensionOf(entry)}`;

/**
 * プロジェクトを配布物にする。ストアに保存されている内容から作る（編集中の未保存の変更は含まれないので、呼び出し側で保存しておく）。
 * - `folder`：ZIP（`index.html` / `player.js` / `project/project.json` / `project/maps/*.json` / `assets/<id>.<ext>` / `README.txt`）。
 * - `singleHtml`：ゲームの JSON とアセット（base64）とプレイヤーを埋め込んだ 1 つの HTML。外部のファイルは読まない。
 */
export async function exportGame(
  repo: ProjectRepository,
  projectId: string,
  opts: ExportOptions,
  player: PlayerBundle,
): Promise<Result<ExportedGame, ProjectStoreError>> {
  const loaded = await repo.load(projectId);
  if (!loaded.ok) return loaded;
  const { project, maps } = loaded.value;
  const store = repo.assets(projectId);
  const stringify = (value: unknown): string => JSON.stringify(value, null, opts.minifyJson === false ? 2 : undefined);

  const projectJson = stringify(serializeProject(project));
  const projectBytes = encoder.encode(projectJson);
  const projectHash = await sha256Hex(projectBytes);
  const mapJson = Object.entries(maps).map(([id, map]) => [id, serializeMapData(map)] as const);

  const assets: { id: string; name: string; bytes: Uint8Array }[] = [];
  const warnings: string[] = [];
  for (const [id, entry] of Object.entries(project.assets.entries)) {
    const bytes = await store.get(id as never);
    if (bytes === undefined) warnings.push(`アセット ${id}（${entry.name}）のデータが無いので含めなかった`);
    else assets.push({ id, name: assetFileName(id, entry), bytes: new Uint8Array(bytes) });
  }

  const name = slug(project.meta.title);
  if (opts.format === "folder") {
    const offline = opts.offline === true;
    const files: ZipFile[] = [
      { name: "index.html", bytes: encoder.encode(renderIndexHtml(project.meta.title, opts.renderer ?? "auto", offline)) },
      { name: "player.js", bytes: encoder.encode(player.js) },
      { name: "project/project.json", bytes: projectBytes },
      ...mapJson.map(([id, json]) => ({ name: `project/maps/${id}.json`, bytes: encoder.encode(stringify(json)) })),
      ...assets.map((a) => ({ name: `assets/${a.name}`, bytes: a.bytes })),
      { name: "README.txt", bytes: encoder.encode(README_TEXT) },
    ];
    if (offline) {
      // キャッシュ名は配布物の内容から決める：中身が変われば別のキャッシュになり、置き直した新しいゲームが古いものに隠されない
      const digest = await sha256Hex(encoder.encode((await Promise.all(files.map(async (f) => `${f.name}:${await sha256Hex(Uint8Array.from(f.bytes))}`))).join("\n")));
      files.push({ name: SW_FILE, bytes: encoder.encode(renderServiceWorker(files.map((f) => f.name), digest.slice(0, 16))) });
    }
    return ok({ bytes: writeZip(files), mime: "application/zip", fileName: `${name}.zip`, warnings });
  }
  if (opts.offline === true) warnings.push("オフライン対応（Service Worker）はフォルダ形式だけ。単一 HTML では無効にした");

  const embedded: EmbeddedGame = {
    project: JSON.parse(projectJson) as unknown,
    maps: Object.fromEntries(mapJson),
    assets: Object.fromEntries(assets.map((a) => [a.id, toBase64(a.bytes)])),
    projectHash,
  };
  const html = renderSingleHtml(project.meta.title, escapeJsonForScript(JSON.stringify(embedded)), escapeForScript(player.js), opts.renderer ?? "auto");
  const bytes = encoder.encode(html);
  if (bytes.length > (opts.warnAboveBytes ?? SINGLE_HTML_WARN_BYTES)) {
    warnings.push(`単一 HTML が ${(bytes.length / 1024 / 1024).toFixed(1)} MB になった。大きいので、フォルダ形式（ZIP）をおすすめする`);
  }
  return ok({ bytes, mime: "text/html", fileName: `${name}.html`, warnings });
}
