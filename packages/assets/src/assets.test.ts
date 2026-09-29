import { describe, expect, it, vi } from "vitest";
import { AssetError } from "@rpg/runtime";
import type { AssetId, AssetManifest, AudioHandle, ImageHandle } from "@rpg/runtime";
import { assetBytesSourceContract } from "@rpg/test-utils";
import { assetExtension, createAssetSource, createHttpBytesSource, createMemoryBytesSource, hashAsset } from "./index.js";

const bytesOf = (...n: number[]): ArrayBuffer => new Uint8Array(n).buffer;
const text = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const id = (s: string): AssetId => s as AssetId;

describe("hashAsset", () => {
  it("sha256 の先頭 16 桁（既知ベクタ）", async () => {
    expect(await hashAsset(text("abc"))).toBe("ba7816bf8f01cfea"); // sha256("abc") = ba7816bf8f01cfea414140de…
    expect(await hashAsset(text(""))).toBe("e3b0c44298fc1c14"); // sha256("") = e3b0c44298fc1c149afbf4c8…
  });
});

assetBytesSourceContract("memory", () => {
  const entries = { [id("1111111111111111")]: bytesOf(1, 2, 3), [id("2222222222222222")]: bytesOf() };
  return { source: createMemoryBytesSource(entries), entries, missingId: "ffffffffffffffff" };
});

const manifest = (entries: Record<string, { name: string; kind: "image" | "audio" | "font" | "data"; mime: string }>): AssetManifest =>
  ({ entries: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { ...v, size: 0 }])) }) as unknown as AssetManifest;

describe("createMemoryBytesSource", () => {
  it("put で後から追加できる", async () => {
    const s = createMemoryBytesSource();
    expect(await s.has(id("aaaaaaaaaaaaaaaa"))).toBe(false);
    s.put(id("aaaaaaaaaaaaaaaa"), bytesOf(9));
    expect(new Uint8Array((await s.getBytes(id("aaaaaaaaaaaaaaaa")))!)[0]).toBe(9);
  });
});

describe("createHttpBytesSource", () => {
  const m = manifest({
    "1111111111111111": { name: "hero.PNG", kind: "image", mime: "image/png" },
    "2222222222222222": { name: "noext", kind: "audio", mime: "audio/ogg" },
    "3333333333333333": { name: "x", kind: "data", mime: "application/x-unknown" },
  });

  it("baseUrl/{id}.{ext} を取得する（拡張子は名前から、無ければ MIME から）", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(bytesOf(7, 8)));
    }) as unknown as typeof fetch;
    const s = createHttpBytesSource("http://x/assets", m, { fetch: fetchFn });
    expect(new Uint8Array((await s.getBytes(id("1111111111111111")))!)).toEqual(new Uint8Array([7, 8]));
    await s.getBytes(id("2222222222222222"));
    await s.getBytes(id("3333333333333333"));
    expect(urls).toEqual(["http://x/assets/1111111111111111.png", "http://x/assets/2222222222222222.ogg", "http://x/assets/3333333333333333.bin"]);
  });

  it("マニフェストに無い ID は通信せず undefined / has は false。404 は undefined、他の失敗は reject", async () => {
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(new Response(null, { status: url.includes("1111") ? 404 : 500 })),
    ) as unknown as typeof fetch;
    const s = createHttpBytesSource("http://x/", m, { fetch: fetchFn });
    expect(await s.has(id("ffffffffffffffff"))).toBe(false);
    expect(await s.getBytes(id("ffffffffffffffff"))).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await s.has(id("1111111111111111"))).toBe(true);
    expect(await s.getBytes(id("1111111111111111"))).toBeUndefined();
    await expect(s.getBytes(id("2222222222222222"))).rejects.toThrow(/HTTP 500/);
  });

  it("assetExtension", () => {
    expect(assetExtension({ name: "a.b.OGG", mime: "" })).toBe("ogg");
    expect(assetExtension({ name: "a", mime: "image/webp" })).toBe("webp");
  });
});

describe("createAssetSource", () => {
  const A = id("aaaaaaaaaaaaaaaa");
  const B = id("bbbbbbbbbbbbbbbb");
  const C = id("cccccccccccccccc");
  const m = manifest({
    aaaaaaaaaaaaaaaa: { name: "a.png", kind: "image", mime: "image/png" },
    bbbbbbbbbbbbbbbb: { name: "b.png", kind: "image", mime: "image/png" },
    cccccccccccccccc: { name: "c.png", kind: "image", mime: "image/png" },
    dddddddddddddddd: { name: "s.ogg", kind: "audio", mime: "audio/ogg" },
    eeeeeeeeeeeeeeee: { name: "d.json", kind: "data", mime: "application/json" },
  });
  const decodeImage = vi.fn((data: ArrayBuffer) => Promise.resolve({ size: data.byteLength } as unknown as ImageHandle));

  const make = (entries: Record<string, ArrayBuffer>, options: Parameters<typeof createAssetSource>[2] = {}) => {
    decodeImage.mockClear();
    const bytes = createMemoryBytesSource(entries as Record<AssetId, ArrayBuffer>);
    const getBytes = vi.spyOn(bytes, "getBytes");
    return { source: createAssetSource(bytes, m, { decodeImage, ...options }), getBytes, bytes };
  };

  it("[inv-1] loadImage を 2 回呼ぶと同じハンドル（キャッシュヒット）で、取得は 1 回", async () => {
    const { source, getBytes } = make({ [A]: bytesOf(1, 2, 3) });
    const h1 = await source.loadImage(A);
    const h2 = await source.loadImage(A);
    expect(h2).toBe(h1);
    expect(getBytes).toHaveBeenCalledTimes(1);
    expect(source.stats()).toEqual({ cachedBytes: 3, entries: 1 });
  });

  it("[inv-2] evict 後の loadImage は再ロードして成功する（別のハンドル）", async () => {
    const { source } = make({ [A]: bytesOf(1) });
    const h1 = await source.loadImage(A);
    source.evict(A);
    expect(source.stats()).toEqual({ cachedBytes: 0, entries: 0 });
    const h2 = await source.loadImage(A);
    expect(h2).not.toBe(h1);
    source.evict(B); // 無いものを evict しても何も起きない
  });

  it("[inv-3] 存在しない ID は AssetError(notFound) で reject。has は false", async () => {
    const { source } = make({});
    await expect(source.loadImage(A)).rejects.toMatchObject({ name: "AssetError", kind: "notFound", id: A });
    await expect(source.loadJson(A)).rejects.toBeInstanceOf(AssetError);
    expect(await source.has(A)).toBe(false);
  });

  it("同じ ID の同時要求は 1 回の取得に合流する", async () => {
    const { source, getBytes } = make({ [A]: bytesOf(1) });
    const [h1, h2, h3] = await Promise.all([source.loadImage(A), source.loadImage(A), source.loadImage(A)]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(getBytes).toHaveBeenCalledTimes(1);
    expect(decodeImage).toHaveBeenCalledTimes(1);
  });

  it("[inv-4] LRU：maxCacheBytes を超えたら古いものから捨て、使ったものは残る", async () => {
    const { source } = make({ [A]: bytesOf(1, 1, 1), [B]: bytesOf(2, 2, 2), [C]: bytesOf(3, 3, 3) }, { maxCacheBytes: 6 });
    await source.loadImage(A);
    await source.loadImage(B);
    await source.loadImage(A); // A を使う → B が最も古くなる
    await source.loadImage(C); // 9 バイト → B を捨てる
    expect(source.stats()).toEqual({ cachedBytes: 6, entries: 2 });
    decodeImage.mockClear();
    await source.loadImage(A);
    expect(decodeImage).not.toHaveBeenCalled();
    await source.loadImage(B);
    expect(decodeImage).toHaveBeenCalledTimes(1);
    expect(source.stats().cachedBytes).toBeLessThanOrEqual(6);
  });

  it("上限より大きい 1 つはキャッシュしない（読み込み自体は成功する）", async () => {
    const { source } = make({ [A]: bytesOf(1, 2, 3, 4) }, { maxCacheBytes: 2 });
    await expect(source.loadImage(A)).resolves.toBeDefined();
    expect(source.stats()).toEqual({ cachedBytes: 0, entries: 0 });
  });

  it("verifyHash: ハッシュが一致しなければ hashMismatch、一致すれば成功", async () => {
    const good = text("abc");
    const goodId = id("ba7816bf8f01cfea");
    const m2 = manifest({ ba7816bf8f01cfea: { name: "a.png", kind: "image", mime: "image/png" } });
    const okSource = createAssetSource(createMemoryBytesSource({ [goodId]: good }), m2, { decodeImage, verifyHash: true });
    await expect(okSource.loadImage(goodId)).resolves.toBeDefined();
    const bad = createAssetSource(createMemoryBytesSource({ [goodId]: text("tampered") }), m2, { decodeImage, verifyHash: true });
    await expect(bad.loadImage(goodId)).rejects.toMatchObject({ kind: "hashMismatch" });
  });

  it("デコード失敗は decodeFailed で、キャッシュに残らず再試行できる", async () => {
    let fail = true;
    const flaky = vi.fn((data: ArrayBuffer) => (fail ? Promise.reject(new Error("bad png")) : Promise.resolve({ size: data.byteLength } as unknown as ImageHandle)));
    const source = createAssetSource(createMemoryBytesSource({ [A]: bytesOf(1) }), m, { decodeImage: flaky });
    await expect(source.loadImage(A)).rejects.toMatchObject({ kind: "decodeFailed" });
    expect(source.stats().entries).toBe(0);
    fail = false;
    await expect(source.loadImage(A)).resolves.toBeDefined();
  });

  it("取得の失敗は network、音声デコーダが無ければ decodeFailed", async () => {
    const bytes = createMemoryBytesSource({ [id("dddddddddddddddd")]: bytesOf(1) });
    vi.spyOn(bytes, "getBytes").mockRejectedValueOnce(new Error("offline"));
    const source = createAssetSource(bytes, m, { decodeImage });
    await expect(source.loadImage(A)).rejects.toMatchObject({ kind: "network" });
    await expect(source.loadAudio(id("dddddddddddddddd"))).rejects.toMatchObject({ kind: "decodeFailed" });
    const withAudio = createAssetSource(bytes, m, { decodeAudio: () => Promise.resolve({} as AudioHandle) });
    await expect(withAudio.loadAudio(id("dddddddddddddddd"))).resolves.toBeDefined();
  });

  it("loadJson は JSON をパースして返す", async () => {
    const { source } = make({ eeeeeeeeeeeeeeee: text('{"a":[1,2]}') });
    expect(await source.loadJson(id("eeeeeeeeeeeeeeee"))).toEqual({ a: [1, 2] });
  });

  it("preload は種類に応じて読み込み、進捗を通知する", async () => {
    const { source } = make({ [A]: bytesOf(1), [B]: bytesOf(2), eeeeeeeeeeeeeeee: text("1") });
    const progress: string[] = [];
    await source.preload([A, B, id("eeeeeeeeeeeeeeee")], (done, total) => progress.push(`${done}/${total}`));
    expect(progress).toEqual(["1/3", "2/3", "3/3"]);
    expect(source.stats().entries).toBe(3);
    await expect(source.preload([C])).rejects.toMatchObject({ kind: "notFound" });
  });
});
