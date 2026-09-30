import { describe, expect, it } from "vitest";
import { crc32, readZip, writeZip } from "./zip.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("zip", () => {
  it("crc32 は既知の値と一致する", () => {
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("writeZip → readZip で名前（日本語を含む）と内容が戻る。空のファイルも扱える", async () => {
    const files = [
      { name: "project.json", bytes: enc('{"a":1}') },
      { name: "maps/マップ.json", bytes: enc("ｘ") },
      { name: "empty", bytes: new Uint8Array() },
      { name: "bin", bytes: Uint8Array.from({ length: 300 }, (_, i) => i % 256) },
    ];
    const read = await readZip(writeZip(files));
    expect([...read.keys()]).toEqual(files.map((f) => f.name));
    for (const f of files) expect(read.get(f.name)).toEqual(f.bytes);
  });

  it("Uint8Array でも ArrayBuffer でも読める。ディレクトリのエントリは無視する", async () => {
    const zip = writeZip([{ name: "dir/", bytes: new Uint8Array() }, { name: "dir/a.txt", bytes: enc("a") }]);
    expect([...(await readZip(zip.buffer)).keys()]).toEqual(["dir/a.txt"]);
  });

  it("deflate 圧縮された ZIP（一般のツールが作るもの）も読める", async () => {
    const payload = enc("deflate されたテキスト。".repeat(20));
    const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    // store の ZIP を作り、ローカルヘッダ・セントラルの方式と圧縮後サイズを deflate に書き換える
    const base = writeZip([{ name: "a.txt", bytes: compressed }]);
    const view = new DataView(base.buffer);
    view.setUint16(8, 8, true); // ローカルヘッダの方式
    const central = base.length - 22 - (46 + 5);
    view.setUint16(central + 10, 8, true); // セントラルの方式
    const files = await readZip(base);
    expect(files.get("a.txt")).toEqual(payload);
  });

  it("壊れた ZIP と未対応の圧縮方式は例外", async () => {
    await expect(readZip(enc("PK but not really"))).rejects.toThrow(/ZIP/);
    const zip = writeZip([{ name: "a", bytes: enc("x") }]);
    new DataView(zip.buffer).setUint16(zip.length - 22 - (46 + 1) + 10, 99, true);
    await expect(readZip(zip)).rejects.toThrow(/未対応の圧縮方式/);
    const noLocal = writeZip([{ name: "a", bytes: enc("x") }]);
    new DataView(noLocal.buffer).setUint32(0, 0, true);
    await expect(readZip(noLocal)).rejects.toThrow(/壊れている/);
  });
});
