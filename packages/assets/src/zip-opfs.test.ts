import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { AssetId } from "@rpg/runtime";
import { assetBytesSourceContract } from "@rpg/test-utils";
import { createOpfsBytesSource, createZipBytesSource, crc32, readZip, writeZip } from "./index.js";

const bytesOf = (...n: number[]): ArrayBuffer => new Uint8Array(n).buffer;
const id = (s: string): AssetId => s as AssetId;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const blobOf = (zip: Uint8Array<ArrayBuffer>): Blob => new Blob([zip]);

const entries = { [id("1111111111111111")]: bytesOf(1, 2, 3), [id("2222222222222222")]: bytesOf() };

assetBytesSourceContract("zip", async () => ({
  source: await createZipBytesSource(
    blobOf(
      writeZip([
        { name: "project.json", bytes: utf8("{}") },
        { name: "assets/1111111111111111.png", bytes: new Uint8Array([1, 2, 3]) },
        { name: "assets/2222222222222222.ogg", bytes: new Uint8Array() },
      ]),
    ),
  ),
  entries,
  missingId: "ffffffffffffffff",
}));

/** `entries()` だけを持つ、メモリ上のフォルダ。 */
function fakeDir(files: Record<string, Uint8Array>): FileSystemDirectoryHandle {
  const handles = Object.entries(files).map(([name, bytes]) => [name, { kind: "file", name, getFile: () => Promise.resolve(new File([bytes as Uint8Array<ArrayBuffer>], name)) }] as const);
  return {
    entries: async function* () {
      for (const h of handles) yield h;
      yield ["sub", { kind: "directory", name: "sub" }];
    },
  } as unknown as FileSystemDirectoryHandle;
}

assetBytesSourceContract("opfs（フォルダのふり）", () => ({
  source: createOpfsBytesSource(fakeDir({ "1111111111111111.png": new Uint8Array([1, 2, 3]), "2222222222222222": new Uint8Array() })),
  entries,
  missingId: "ffffffffffffffff",
}));

describe("opfs", () => {
  it("ID の前方一致で別のファイルを拾わない", async () => {
    const source = createOpfsBytesSource(fakeDir({ "11111111111111112.png": new Uint8Array([9]) }));
    expect(await source.has(id("1111111111111111"))).toBe(false);
  });

  it("フォルダ（sub）は無視する", async () => {
    const source = createOpfsBytesSource(fakeDir({}));
    expect(await source.has(id("sub"))).toBe(false);
  });
});

describe("zip", () => {
  it("crc32 の既知ベクタ", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  });

  it("writeZip → readZip のラウンドトリップ（日本語のファイル名を含む）", async () => {
    const files = [
      { name: "設定/はじめに.txt", bytes: utf8("こんにちは") },
      { name: "a.bin", bytes: new Uint8Array([0, 255, 7]) },
    ];
    const read = await readZip(blobOf(writeZip(files)));
    expect([...read.keys()]).toEqual(["設定/はじめに.txt", "a.bin"]);
    expect(new TextDecoder().decode(read.get("設定/はじめに.txt"))).toBe("こんにちは");
    expect(read.get("a.bin")).toEqual(new Uint8Array([0, 255, 7]));
  });

  it("deflate で圧縮された ZIP も読める", async () => {
    const data = utf8("abcabcabcabcabcabc".repeat(20));
    const compressed = deflateRawSync(data);
    // writeZip で作った store の ZIP を、圧縮方式 8・圧縮サイズに書き換えて本物の deflate ZIP にする
    const stored = writeZip([{ name: "x.txt", bytes: new Uint8Array(compressed) }]);
    const view = new DataView(stored.buffer);
    view.setUint16(8, 8, true); // ローカルヘッダの圧縮方式
    const central = 30 + 5 + compressed.length;
    view.setUint16(central + 10, 8, true); // セントラルの圧縮方式
    const read = await readZip(blobOf(stored));
    expect(read.get("x.txt")).toEqual(new Uint8Array(data));
  });

  it("ZIP でないデータ・壊れたデータ・未対応の圧縮方式は reject", async () => {
    await expect(readZip(new Blob(["not a zip at all, definitely"]))).rejects.toThrow("ZIP ではない");
    const zip = writeZip([{ name: "x", bytes: utf8("x") }]);
    const bad = zip.slice();
    new DataView(bad.buffer).setUint32(0, 0, true); // ローカルヘッダの署名を壊す
    await expect(readZip(blobOf(bad))).rejects.toThrow("壊れている");
    const method = writeZip([{ name: "x", bytes: utf8("x") }]);
    new DataView(method.buffer).setUint16(30 + 1 + 1 + 10, 99, true); // セントラルの圧縮方式
    await expect(readZip(blobOf(method))).rejects.toThrow("未対応の圧縮方式");
  });

  it("assets/ 以外のファイルは AssetBytesSource に現れない", async () => {
    const source = await createZipBytesSource(blobOf(writeZip([{ name: "maps/1111111111111111.json", bytes: utf8("{}") }])));
    expect(await source.has(id("1111111111111111"))).toBe(false);
  });
});
