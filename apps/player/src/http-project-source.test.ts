import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FIXTURES_ROOT } from "@rpg/test-utils";
import { createHttpProjectSource } from "./http-project-source.js";

const DEMO = join(FIXTURES_ROOT, "projects", "v1", "demo");
const BASE = "http://game.test/project/";

/** `http://game.test/project/<path>` を demo フォルダのファイルとして返す fetch。`overrides` で差し替え。 */
function fakeFetch(overrides: Record<string, { status?: number; body?: string }> = {}) {
  const calls: string[] = [];
  const fn = vi.fn((url: string) => {
    calls.push(url);
    const path = url.slice(BASE.length);
    const o = overrides[path];
    if (o) return Promise.resolve(new Response(o.body ?? "", { status: o.status ?? 200 }));
    try {
      return Promise.resolve(new Response(readFileSync(join(DEMO, path))));
    } catch {
      return Promise.resolve(new Response("nf", { status: 404 }));
    }
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

describe("createHttpProjectSource", () => {
  it("project.json を一度だけ取得して検証し、projectHash はそのバイト列の sha256", async () => {
    const { fetch, calls } = fakeFetch();
    const source = createHttpProjectSource(`${BASE}project.json`, { fetch });
    const [project, hash, again] = await Promise.all([source.project(), source.projectHash(), source.project()]);
    expect(project.meta.id).toBe("demo");
    expect(again).toBe(project);
    expect(hash).toBe(createHash("sha256").update(readFileSync(join(DEMO, "project.json"))).digest("hex"));
    expect(calls).toEqual([`${BASE}project.json`]);
  });

  it("マップは maps/<id>.json から取得・検証し、取得済みは覚えておく", async () => {
    const { fetch, calls } = fakeFetch();
    const source = createHttpProjectSource(`${BASE}project.json`, { fetch });
    const town = await source.mapData("map_town" as never);
    expect(town).toMatchObject({ id: "map_town", width: 16, height: 12 });
    expect(await source.mapData("map_town" as never)).toBe(town);
    expect(calls.filter((c) => c.endsWith("map_town.json"))).toHaveLength(1);
  });

  it("プロジェクトに無いマップ ID は取得しない（パスを組み立てさせない）", async () => {
    const { fetch, calls } = fakeFetch();
    const source = createHttpProjectSource(`${BASE}project.json`, { fetch });
    await expect(source.mapData("../secret" as never)).rejects.toThrow(/プロジェクトに無い/);
    expect(calls).toEqual([`${BASE}project.json`]);
  });

  it("HTTP エラー・不正な JSON はメッセージ付きで reject。失敗したマップは次回やり直せる", async () => {
    const missing = createHttpProjectSource(`${BASE}nope.json`, { fetch: fakeFetch().fetch });
    await expect(missing.project()).rejects.toThrow(/404/);

    const broken = createHttpProjectSource(`${BASE}project.json`, { fetch: fakeFetch({ "project.json": { body: '{"formatVersion":1}' } }).fetch });
    await expect(broken.project()).rejects.toThrow(/project\.json が不正/);

    let failOnce = true;
    const real = fakeFetch();
    const flaky = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith("map_house.json") && failOnce) {
        failOnce = false;
        return Promise.resolve(new Response("", { status: 503 }));
      }
      return real.fetch(url);
    }) as unknown as typeof fetch;
    const source = createHttpProjectSource(`${BASE}project.json`, { fetch: flaky });
    await expect(source.mapData("map_house" as never)).rejects.toThrow(/503/);
    await expect(source.mapData("map_house" as never)).resolves.toMatchObject({ id: "map_house" });

    const badMap = createHttpProjectSource(`${BASE}project.json`, { fetch: fakeFetch({ "maps/map_house.json": { body: '{"id":"map_house"}' } }).fetch });
    await expect(badMap.mapData("map_house" as never)).rejects.toThrow(/map_house\.json が不正/);
  });
});
