import { createMemoryProjectRepository, readZip } from "@rpg/project-store";
import { parseMapData, parseProject } from "@rpg/schema";
import { describe, expect, it } from "vitest";
import { escapeForScript, escapeJsonForScript, exportGame, renderServiceWorker, SW_FILE, toBase64 } from "./index.js";
import type { EmbeddedGame } from "./index.js";

const PLAYER = { js: 'console.log("player");' };
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function setup() {
  const repo = createMemoryProjectRepository();
  const doc = await repo.create("わたしの/ゲーム: 第1章");
  return { repo, doc, id: doc.project.meta.id };
}

/** 単一 HTML から埋め込みのゲーム JSON を取り出す。 */
function embeddedOf(html: string): EmbeddedGame {
  const m = /<script type="application\/json" id="rpg-embedded">([\s\S]*?)<\/script>/.exec(html);
  if (m?.[1] === undefined) throw new Error("埋め込みの JSON が無い");
  return JSON.parse(m[1]) as EmbeddedGame;
}

describe("exportGame（フォルダ形式）", () => {
  it("index.html / player.js / project/ / assets/ / README.txt を持つ ZIP になる。ファイル名はタイトルから", async () => {
    const { repo, doc, id } = await setup();
    const r = await exportGame(repo, id, { format: "folder" }, PLAYER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ mime: "application/zip", fileName: "わたしの-ゲーム-第1章.zip", warnings: [] });

    const files = await readZip(r.value.bytes);
    const assetNames = Object.entries(doc.project.assets.entries).map(([aid, e]) => `assets/${aid}.${e.name.split(".").pop()}`);
    expect([...files.keys()].sort()).toEqual(["README.txt", "index.html", "player.js", "project/maps/map_001.json", "project/project.json", ...assetNames].sort());
    expect(decode(files.get("player.js")!)).toBe(PLAYER.js);
    expect(decode(files.get("index.html")!)).toContain('<script type="module" src="player.js"></script>');
    expect(decode(files.get("README.txt")!)).toContain("immutable");
  });

  it("project.json / maps は検証を通り、元の文書と等価。アセットのバイト列は同じ", async () => {
    const { repo, doc, id } = await setup();
    const r = await exportGame(repo, id, { format: "folder" }, PLAYER);
    if (!r.ok) throw new Error("export に失敗");
    const files = await readZip(r.value.bytes);
    const project = parseProject(JSON.parse(decode(files.get("project/project.json")!)));
    expect(project.ok && project.value).toEqual(doc.project);
    const map = parseMapData(JSON.parse(decode(files.get("project/maps/map_001.json")!)), 1);
    expect(map.ok && map.value).toEqual(doc.maps["map_001" as never]);
    for (const aid of Object.keys(doc.project.assets.entries)) {
      const name = [...files.keys()].find((n) => n.startsWith(`assets/${aid}.`))!;
      expect(new Uint8Array(files.get(name)!)).toEqual(new Uint8Array((await repo.assets(id).get(aid as never))!));
    }
  });

  it("minifyJson: false なら整形して書き出す（既定は圧縮）", async () => {
    const { repo, id } = await setup();
    const compact = await exportGame(repo, id, { format: "folder" }, PLAYER);
    const pretty = await exportGame(repo, id, { format: "folder", minifyJson: false }, PLAYER);
    if (!compact.ok || !pretty.ok) throw new Error("export に失敗");
    const a = decode((await readZip(compact.value.bytes)).get("project/project.json")!);
    const b = decode((await readZip(pretty.value.bytes)).get("project/project.json")!);
    expect(a).not.toContain("\n");
    expect(b).toContain("\n  ");
    expect(JSON.parse(a)).toEqual(JSON.parse(b));
  });

  it("バイト列が無いアセットは警告して含めない。存在しないプロジェクトは notFound", async () => {
    const { repo, doc, id } = await setup();
    const [aid] = Object.keys(doc.project.assets.entries);
    await repo.assets(id).remove(aid as never);
    const r = await exportGame(repo, id, { format: "folder" }, PLAYER);
    expect(r.ok && r.value.warnings).toHaveLength(1);
    expect(r.ok && r.value.warnings[0]).toContain(aid);
    expect(await exportGame(repo, "nothing", { format: "folder" }, PLAYER)).toEqual({ ok: false, error: { kind: "notFound" } });
  });

  it("タイトルが空や記号だけでも、ファイル名は game.zip になる", async () => {
    const repo = createMemoryProjectRepository();
    const doc = await repo.create(" /:* ");
    const r = await exportGame(repo, doc.project.meta.id, { format: "folder" }, PLAYER);
    expect(r.ok && r.value.fileName).toBe("game.zip");
  });
});

describe("exportGame（単一 HTML）", () => {
  it("[inv-2] 1 つの HTML に、ゲーム・アセット（base64）・プレイヤーが入り、外部のファイルを読まない", async () => {
    const { repo, doc, id } = await setup();
    const r = await exportGame(repo, id, { format: "singleHtml" }, PLAYER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ mime: "text/html", fileName: "わたしの-ゲーム-第1章.html", warnings: [] });
    const html = decode(r.value.bytes);
    expect(html).toContain('console.log("player");');
    // 外部参照なし：src= / href= は data: の favicon だけ
    expect([...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1])).toEqual(["data:,"]);
    expect(html).not.toMatch(/https?:\/\//);

    const embedded = embeddedOf(html);
    expect(parseProject(embedded.project)).toMatchObject({ ok: true });
    expect(Object.keys(embedded.maps)).toEqual(["map_001"]);
    for (const aid of Object.keys(doc.project.assets.entries)) {
      const original = new Uint8Array((await repo.assets(id).get(aid as never))!);
      expect(Uint8Array.from(atob(embedded.assets[aid]!), (c) => c.charCodeAt(0))).toEqual(original);
    }
  });

  it("[inv-1] projectHash は project.json（フォルダ形式）のバイト列の sha256 と同じ", async () => {
    const { repo, id } = await setup();
    const folder = await exportGame(repo, id, { format: "folder" }, PLAYER);
    const single = await exportGame(repo, id, { format: "singleHtml" }, PLAYER);
    if (!folder.ok || !single.ok) throw new Error("export に失敗");
    const projectJson = (await readZip(folder.value.bytes)).get("project/project.json")!;
    expect(embeddedOf(decode(single.value.bytes)).projectHash).toBe(await sha256(Uint8Array.from(projectJson)));
  });

  it("プレイヤーの JS や本文に </script> や <!-- があっても HTML が壊れない", async () => {
    const repo = createMemoryProjectRepository();
    const doc = await repo.create("</script><script>alert(1)</script>");
    const tricky = { js: 'const a = "</script><!-- </SCRIPT>"; // \u2028' };
    const r = await exportGame(repo, doc.project.meta.id, { format: "singleHtml" }, tricky);
    if (!r.ok) throw new Error("export に失敗");
    const html = decode(r.value.bytes);
    expect(html.match(/<\/script>/gi)).toHaveLength(2); // JSON 用とプレイヤー用の 2 つだけ
    expect(html.match(/<script/gi)).toHaveLength(2);
    expect(html).not.toContain("<!--");
    expect(embeddedOf(html).project).toMatchObject({ meta: { title: "</script><script>alert(1)</script>" } });
    expect(r.value.fileName).toBe("script-script-alert(1)-script.html");
  });

  it("大きな単一 HTML は警告する（しきい値は変えられる）", async () => {
    const { repo, id } = await setup();
    const r = await exportGame(repo, id, { format: "singleHtml", warnAboveBytes: 100 }, PLAYER);
    expect(r.ok && r.value.warnings).toHaveLength(1);
    expect(r.ok && r.value.warnings[0]).toContain("フォルダ形式");
  });
});

describe("エスケープと base64", () => {
  it("escapeForScript は </script と <!-- だけを変える", () => {
    expect(escapeForScript("a</script>b</SCRIPT>c<!--d")).toBe("a<\\/script>b<\\/SCRIPT>c<\\!--d");
    expect(escapeForScript("if (a < b && c > d) {}")).toBe("if (a < b && c > d) {}");
  });

  it("escapeJsonForScript は < と行区切り文字を \\u 形式にし、JSON としては同じ", () => {
    const value = { s: "</script> \u2028 \u2029 <b>" };
    const escaped = escapeJsonForScript(JSON.stringify(value));
    expect(escaped).not.toMatch(/[<\u2028\u2029]/);
    expect(JSON.parse(escaped)).toEqual(value);
  });

  it("toBase64 は大きなバイト列も Buffer と同じ結果になる（空も）", () => {
    const big = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 7) % 256);
    expect(toBase64(big)).toBe(Buffer.from(big).toString("base64"));
    expect(toBase64(new Uint8Array())).toBe("");
  });
});

describe("描画方式とオフライン対応", () => {
  const html = async (opts: Parameters<typeof exportGame>[2]): Promise<string> => {
    const { repo, id } = await setup();
    const r = await exportGame(repo, id, opts, PLAYER);
    if (!r.ok) throw new Error("export に失敗");
    return opts.format === "folder" ? decode((await readZip(r.value.bytes)).get("index.html")!) : decode(r.value.bytes);
  };

  it("描画方式は #app の data-renderer に入る（既定は auto）。フォルダ形式にも単一 HTML にも", async () => {
    expect(await html({ format: "folder" })).toContain('<div id="app" data-renderer="auto">');
    expect(await html({ format: "folder", renderer: "webgl" })).toContain('data-renderer="webgl"');
    expect(await html({ format: "singleHtml", renderer: "canvas2d" })).toContain('data-renderer="canvas2d"');
    expect(await html({ format: "singleHtml" })).toContain('data-renderer="auto"');
  });

  it("offline：フォルダ形式に sw.js と登録のスクリプトが付く。付けなければ無い", async () => {
    const { repo, doc, id } = await setup();
    const off = await exportGame(repo, id, { format: "folder", offline: true }, PLAYER);
    const plain = await exportGame(repo, id, { format: "folder" }, PLAYER);
    if (!off.ok || !plain.ok) throw new Error("export に失敗");
    const files = await readZip(off.value.bytes);
    const sw = decode(files.get(SW_FILE)!);
    expect(decode(files.get("index.html")!)).toContain('navigator.serviceWorker.register("sw.js")');
    // キャッシュするのは sw.js 以外のすべてのファイル（と "./"）
    const listed = JSON.parse(/const FILES = (.*);/.exec(sw)![1]!) as string[];
    expect(listed.sort()).toEqual(["./", ...[...files.keys()].filter((n) => n !== SW_FILE)].sort());
    expect(listed).toEqual(expect.arrayContaining(["index.html", "player.js", "project/project.json", ...Object.keys(doc.project.assets.entries).map((a) => `assets/${a}.png`)]));

    const plainFiles = await readZip(plain.value.bytes);
    expect(plainFiles.has(SW_FILE)).toBe(false);
    expect(decode(plainFiles.get("index.html")!)).not.toContain("serviceWorker");
  });

  it("キャッシュ名は配布物の内容から決まる：同じなら同じ、変わったら別", async () => {
    const { repo, id } = await setup();
    const version = async (js: string): Promise<string> => {
      const r = await exportGame(repo, id, { format: "folder", offline: true }, { js });
      if (!r.ok) throw new Error("export に失敗");
      return /const CACHE = "(rpg-[0-9a-f]+)"/.exec(decode((await readZip(r.value.bytes)).get(SW_FILE)!))![1]!;
    };
    expect(await version("a")).toBe(await version("a"));
    expect(await version("a")).not.toBe(await version("b"));
  });

  it("単一 HTML では offline は無効で、警告する", async () => {
    const { repo, id } = await setup();
    const r = await exportGame(repo, id, { format: "singleHtml", offline: true }, PLAYER);
    expect(r.ok && r.value.warnings).toEqual([expect.stringContaining("単一 HTML")]);
    expect(r.ok && decode(r.value.bytes)).not.toContain("serviceWorker");
  });

  it("renderServiceWorker：install で全ファイルをキャッシュし、activate で古い rpg- キャッシュを消し、GET だけを扱う", () => {
    const src = renderServiceWorker(["index.html", "sw.js", "a/b.png"], "abc");
    expect(src).toContain('const CACHE = "rpg-abc";');
    expect(src).toContain('const FILES = ["./","index.html","a/b.png"];'); // sw.js 自身は入れない
    expect(src).toContain('key.startsWith("rpg-") && key !== CACHE');
    expect(src).toContain('request.method !== "GET"');
    // 構文として正しい（実行はしない）
    expect(() => new Function(src)).not.toThrow();
  });
});
