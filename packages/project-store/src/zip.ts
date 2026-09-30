/**
 * 最小の ZIP 入出力（プロジェクトの書き出し・読み込み用）。`@rpg/assets` の `zip.ts` と同じ形式を扱う
 * （project-store は schema にしか依存できないので、こちらにも持つ）。書き出しは無圧縮（store）、読み込みは store と deflate。
 */
export interface ZipFile {
  name: string;
  bytes: Uint8Array;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 無圧縮（store）の ZIP を作る。ファイル名は UTF-8。エクスポートとテストの下地。 */
export function writeZip(files: readonly ZipFile[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true); // 展開に必要なバージョン
    local.setUint16(6, 0x0800, true); // UTF-8 のファイル名
    local.setUint32(14, crc, true);
    local.setUint32(18, f.bytes.length, true);
    local.setUint32(22, f.bytes.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, SIG_CENTRAL, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, f.bytes.length, true);
    entry.setUint32(24, f.bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + f.bytes.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_END, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readCentral(buf: Uint8Array): CentralEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP ではない（終端レコードが無い）");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const dec = new TextDecoder();
  const entries: CentralEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== SIG_CENTRAL) throw new Error("ZIP が壊れている（セントラルディレクトリ）");
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    entries.push({
      name: dec.decode(buf.subarray(at + 46, at + 46 + nameLen)),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extract(buf: Uint8Array, entry: CentralEntry): Promise<Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const at = entry.localOffset;
  if (view.getUint32(at, true) !== SIG_LOCAL) throw new Error(`ZIP が壊れている（${entry.name}）`);
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`未対応の圧縮方式 ${entry.method}（${entry.name}）`);
}

/** ZIP の中身（ディレクトリを除く）を `名前 → バイト列` で読む。store と deflate に対応。 */
export async function readZip(zip: Uint8Array | ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const buf = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
  const files = new Map<string, Uint8Array>();
  for (const entry of readCentral(buf)) {
    if (entry.name.endsWith("/")) continue;
    files.set(entry.name, await extract(buf, entry));
  }
  return files;
}
