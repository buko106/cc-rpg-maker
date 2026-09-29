#!/usr/bin/env node
/**
 * 静的ファイルを配信する最小のサーバ（E2E とローカル確認用）。
 *
 *   node tools/serve-static.mjs <dir> [port]
 */
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const dir = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".css": "text/css; charset=utf-8",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let file = normalize(join(dir, decodeURIComponent(url.pathname)));
  if (file !== dir && !file.startsWith(dir + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port}/`));
