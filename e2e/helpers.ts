import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "@playwright/test";
import type { Download, Page } from "@playwright/test";

/** 最小の ZIP 読み込み（無圧縮のエントリだけ）。エクスポータとは別の実装で、ZIP の構造を確かめる。 */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("ZIP ではない");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("セントラルディレクトリが壊れている");
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    if (method !== 0) throw new Error(`圧縮されている: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, buf.subarray(start, start + size));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json", png: "image/png" };

/** ファイルの集まりを、別のオリジン（ランダムなポート）の静的サーバで配信する。 */
export async function serve(files: Map<string, Buffer>): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\//, "") || "index.html";
    const body = files.get(path);
    if (body === undefined) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** 書き出し画面で形式を選んで書き出し、ダウンロードされたファイルを保存する。 */
export async function exportAs(page: Page, format: RegExp, path: string): Promise<Download> {
  await page.getByRole("button", { name: "配布物を書き出す…" }).click();
  await page.getByRole("radio", { name: format }).check();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("dialog", { name: "配布物の書き出し" }).getByRole("button", { name: "書き出す" }).click()]);
  await download.saveAs(path);
  await expect(page.getByRole("status").filter({ hasText: "を書き出しました" })).toBeVisible();
  await page.getByRole("dialog", { name: "配布物の書き出し" }).getByRole("button", { name: "閉じる", exact: true }).click();
  return download;
}

