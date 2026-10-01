// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readZip, writeZip } from "@rpg/project-store";
import { FIXTURES_ROOT, loadFixtureProject } from "@rpg/test-utils";
import { App } from "./App.js";
import { createSampleSource } from "./browser-env.js";
import type { ProjectSample } from "./hooks.js";
import { createTestEnv } from "./test-env.js";
import type { TestEnv } from "./test-env.js";

// サンプル（デモの編集データ）。エディタのビルド（scripts/build-web.mjs）が samples/<id>/ に置くのと同じ、fixtures/projects/v1/<name> のフォルダ
const SAMPLES = [
  { id: "village", fixture: "demo", title: "はじまりの村" },
  { id: "maze", fixture: "maze", title: "地下迷宮" },
  { id: "tower", fixture: "tower", title: "バトルタワー" },
  { id: "mansion", fixture: "mansion", title: "謎解きの館" },
  { id: "haunted", fixture: "haunted", title: "おばけ屋敷の追いかけっこ" },
  { id: "stealth", fixture: "stealth", title: "忍び込み！月影の宝物庫" },
  { id: "hokora", fixture: "hokora", title: "ほこらの冒険" },
  { id: "ice", fixture: "ice", title: "氷の神殿" },
  { id: "water", fixture: "water", title: "水門の遺跡" },
] as const;
const dirOf = (fixture: string): string => join(FIXTURES_ROOT, "projects", "v1", fixture);
const filesOf = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .sort();
const zipOf = (fixture: string): Uint8Array<ArrayBuffer> => writeZip(filesOf(dirOf(fixture)).map((name) => ({ name, bytes: readFileSync(join(dirOf(fixture), name)) })));
const sampleOf = (s: (typeof SAMPLES)[number]): ProjectSample => ({ id: s.id, title: s.title, description: `${s.title}の説明`, tags: ["タグ"] });

/** `samples/` を配る fetch の代わり（index.json と、サンプルのフォルダのファイル）。 */
function fakeFetch(base: string, files: Record<string, Uint8Array | string>): typeof fetch {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith(base) ? files[url.slice(base.length)] : undefined;
    return Promise.resolve(body === undefined ? new Response("not found", { status: 404 }) : new Response(body as BodyInit));
  }) as unknown as typeof fetch;
}

let t: TestEnv;
beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
  t = await createTestEnv({ samples: SAMPLES.map((s) => ({ sample: sampleOf(s), zip: () => Promise.resolve(zipOf(s.fixture)) })) });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const editor = () => (window as unknown as { __editor: { doc: { project: { meta: { id: string; title: string } }; maps: Record<string, unknown> } } }).__editor;

describe("サンプルから作る", () => {
  it.each(SAMPLES)("$title のサンプル（$fixture）を取り込むと、同じ内容の新しいプロジェクトとして開く", async (s) => {
    render(<App env={t.env} repo={t.repo} />);
    const list = await screen.findByRole("list", { name: "サンプル" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(SAMPLES.length);
    fireEvent.click(screen.getByRole("button", { name: `${s.title} のサンプルから作る` }));
    await waitFor(() => expect(screen.getByRole("application")).toBeTruthy());

    const fixture = loadFixtureProject(s.fixture);
    const doc = editor().doc;
    expect(doc.project.meta.title).toBe(fixture.project.meta.title);
    expect(doc.project.meta.id).not.toBe(fixture.project.meta.id);
    expect(Object.keys(doc.maps).sort()).toEqual(Object.keys(fixture.maps).sort());
    expect(doc.maps).toEqual(fixture.maps);
    // アセットのバイト列も入っている
    for (const assetId of Object.keys(fixture.project.assets.entries)) {
      expect(await t.repo.assets(doc.project.meta.id).get(assetId as never), assetId).toBeDefined();
    }

    // 一覧に戻ると、取り込んだプロジェクトが並ぶ
    fireEvent.click(screen.getByRole("button", { name: "← プロジェクト一覧" }));
    expect(await screen.findByRole("button", { name: `${fixture.project.meta.title} を開く` })).toBeTruthy();
  });

  it("サンプルが無ければ「サンプルから作る」は出ない", async () => {
    const env = await createTestEnv();
    render(<App env={env.env} repo={env.repo} />);
    await screen.findByRole("list", { name: "プロジェクト一覧" });
    expect(screen.queryByRole("heading", { name: "サンプルから作る" })).toBeNull();
  });

  it("サンプルを読めなければ理由を出し、一覧に留まる", async () => {
    const env = await createTestEnv({ samples: [{ sample: sampleOf(SAMPLES[0]), zip: () => Promise.reject(new Error("HTTP 500")) }] });
    render(<App env={env.env} repo={env.repo} />);
    fireEvent.click(await screen.findByRole("button", { name: "はじまりの村 のサンプルから作る" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("読み込めません（HTTP 500）"));
    expect(screen.getByRole("list", { name: "プロジェクト一覧" })).toBeTruthy();
  });

  it("サンプルの一覧を読めなければ理由を出す", async () => {
    render(<App env={{ ...t.env, listSamples: () => Promise.reject(new Error("HTTP 500")) }} repo={t.repo} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("サンプルの一覧を読めません（HTTP 500）"));
  });
});

describe("ZIP の書き出しと読み込み（編集データ）", () => {
  it("一覧の「ZIP」で編集データを書き出し、「ZIP から読み込む…」で新しいプロジェクトとして取り込める", async () => {
    render(<App env={t.env} repo={t.repo} />);
    fireEvent.click(await screen.findByRole("button", { name: "テスト を ZIP に書き出す" }));
    await waitFor(() => expect(t.saved).toHaveLength(1));
    expect(t.saved[0]).toMatchObject({ name: "テスト.zip", mime: "application/zip" });
    const names = [...(await readZip(t.saved[0]!.bytes)).keys()];
    expect(names).toContain("project.json");
    expect(names).toContain("maps/map_001.json");

    const file = new File([t.saved[0]!.bytes], "テスト.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("読み込む ZIP ファイル"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("application")).toBeTruthy());
    expect(editor().doc.project.meta.title).toBe("テスト");
    expect(editor().doc.project.meta.id).not.toBe(t.session.doc.project.meta.id);
    expect((await t.repo.list()).filter((p) => p.title === "テスト")).toHaveLength(2);
  });

  it("壊れた ZIP は理由を出して取り込まない", async () => {
    render(<App env={t.env} repo={t.repo} />);
    await screen.findByRole("list", { name: "プロジェクト一覧" });
    const file = new File([new Uint8Array([1, 2, 3])], "broken.zip");
    fireEvent.change(screen.getByLabelText("読み込む ZIP ファイル"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/^読み込めません（zip: /));
    expect(await t.repo.list()).toHaveLength(1);
  });

  it("書き出せなければ理由を出す", async () => {
    render(<App env={t.env} repo={{ ...t.repo, exportZip: () => Promise.resolve({ ok: false, error: { kind: "notFound" } }) }} />);
    fireEvent.click(await screen.findByRole("button", { name: "テスト を ZIP に書き出す" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("書き出せません（notFound）"));
    expect(t.saved).toEqual([]);
  });
});

describe("createSampleSource（ブラウザでのサンプルの取得）", () => {
  const base = "samples/";
  const served = (): Record<string, Uint8Array | string> => {
    const files: Record<string, Uint8Array | string> = {};
    const index = SAMPLES.map((s) => {
      const names = filesOf(dirOf(s.fixture));
      for (const n of names) files[`${s.id}/${n}`] = readFileSync(join(dirOf(s.fixture), n));
      return { id: s.id, title: s.title, description: "説明", tags: ["タグ"], image: `${s.id}.png`, files: names };
    });
    files["index.json"] = JSON.stringify(index);
    return files;
  };

  it("index.json から一覧を作り、サンプルのファイルを ZIP にまとめる（importZip で取り込める）", async () => {
    const src = createSampleSource(base, fakeFetch(base, served()));
    expect(await src.listSamples()).toEqual(SAMPLES.map((s) => ({ id: s.id, title: s.title, description: "説明", tags: ["タグ"], imageUrl: `samples/${s.id}.png` })));
    for (const s of SAMPLES) {
      const r = await t.repo.importZip(await src.loadSample(s.id));
      expect(r.ok, s.id).toBe(true);
      const loaded = await t.repo.load(r.ok ? r.value.id : "");
      expect(loaded.ok && loaded.value.maps).toEqual(loadFixtureProject(s.fixture).maps);
    }
  });

  it("index.json が無ければサンプルは無い。無いサンプル・欠けたファイルは失敗する", async () => {
    expect(await createSampleSource(base, fakeFetch(base, {})).listSamples()).toEqual([]);
    const files = served();
    delete files["maze/project.json"];
    const src = createSampleSource(base, fakeFetch(base, files));
    await expect(src.loadSample("nothing")).rejects.toThrow("サンプル「nothing」が無い");
    await expect(src.loadSample("maze")).rejects.toThrow("project.json");
  });

  it("一覧の取得に失敗したら、次に呼んだときに取り直す", async () => {
    const files = served();
    let fail = true;
    const ok = fakeFetch(base, files);
    const src = createSampleSource(base, ((input: RequestInfo | URL) => (fail ? Promise.resolve(new Response("", { status: 500 })) : ok(input))) as typeof fetch);
    await expect(src.listSamples()).rejects.toThrow("HTTP 500");
    fail = false;
    expect(await src.listSamples()).toHaveLength(SAMPLES.length);
  });
});
