// @vitest-environment jsdom
import { cmd } from "@rpg/editor-core";
import { readZip } from "@rpg/project-store";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv } from "../test-env.js";
import type { TestEnv } from "../test-env.js";
import { ExportDialog } from "./ExportDialog.js";

let t: TestEnv;
let closed = 0;
beforeEach(async () => {
  t = await createTestEnv();
  closed = 0;
  render(t.wrap(<ExportDialog onClose={() => closed++} />));
});
afterEach(cleanup);

const exportNow = (): void => void fireEvent.click(screen.getByRole("button", { name: "書き出す" }));

describe("ExportDialog", () => {
  it("フォルダ形式（既定）：ZIP を保存し、名前とサイズを知らせる", async () => {
    exportNow();
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0]).toMatchObject({ name: "テスト.zip", mime: "application/zip" });
    const files = await readZip(t.saved[0]!.bytes);
    expect([...files.keys()]).toEqual(expect.arrayContaining(["index.html", "player.js", "project/project.json", "README.txt"]));
    expect(new TextDecoder().decode(files.get("player.js")!)).toBe("/* player */");
    expect(within(screen.getByRole("status")).getByText(/「テスト\.zip」を書き出しました/)).toBeTruthy();
  });

  it("JSON を圧縮しない選択が project.json に効く", async () => {
    fireEvent.click(screen.getByRole("checkbox", { name: /圧縮する/ }));
    exportNow();
    await waitFor(() => expect(t.saved).toHaveLength(1));
    const files = await readZip(t.saved[0]!.bytes);
    expect(new TextDecoder().decode(files.get("project/project.json")!)).toContain('\n  "formatVersion"');
  });

  it("描画方式とオフライン対応の選択が書き出しに効く。オフラインは単一 HTML では選べない", async () => {
    fireEvent.change(screen.getByLabelText("描画方式"), { target: { value: "canvas2d" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /オフライン/ }));
    exportNow();
    await waitFor(() => expect(t.saved).toHaveLength(1));
    const files = await readZip(t.saved[0]!.bytes);
    expect(files.has("sw.js")).toBe(true);
    expect(new TextDecoder().decode(files.get("index.html")!)).toContain('data-renderer="canvas2d"');
    // 単一 HTML ではチェックボックスが無効（チェックも外れて見える）
    fireEvent.click(screen.getByRole("radio", { name: /単一 HTML/ }));
    const box = screen.getByRole("checkbox", { name: /オフライン/ }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    exportNow();
    await waitFor(() => expect(t.saved).toHaveLength(2));
    expect(new TextDecoder().decode(t.saved[1]!.bytes)).not.toContain("serviceWorker");
  });

  it("単一 HTML を選ぶと HTML を保存する", async () => {
    fireEvent.click(screen.getByRole("radio", { name: /単一 HTML/ }));
    exportNow();
    await waitFor(() => expect(t.saved).toHaveLength(1));
    expect(t.saved[0]).toMatchObject({ name: "テスト.html", mime: "text/html" });
    const html = new TextDecoder().decode(t.saved[0]!.bytes);
    expect(html).toContain("/* player */");
    expect(html).toContain('id="rpg-embedded"');
  });

  it("書き出す前に未保存の変更を保存する", async () => {
    act(() => void t.session.execute(cmd.setSwitchName("sw_x" as never, "新しいスイッチ")));
    expect(t.session.dirty).toBe(true);
    exportNow();
    await waitFor(() => expect(t.saved).toHaveLength(1));
    expect(t.session.dirty).toBe(false);
    const files = await readZip(t.saved[0]!.bytes);
    expect(new TextDecoder().decode(files.get("project/project.json")!)).toContain("sw_x");
  });

  it("保存できないときは書き出さず、理由を出す", async () => {
    act(() => void t.session.execute(cmd.setSwitchName("sw_y" as never, "y")));
    t.repo.save = () => Promise.resolve({ ok: false, error: { kind: "io", message: "だめ" } });
    exportNow();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("先に保存できなかった");
    expect(t.saved).toEqual([]);
  });

  it("プレイヤー本体を取れないときは、エラーを出して書き出さない。ボタンは押し直せる", async () => {
    t.env.loadPlayerBundle = () => Promise.reject(new Error("player.js が無い"));
    exportNow();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("player.js が無い");
    expect(t.saved).toEqual([]);
    expect((screen.getByRole("button", { name: "書き出す" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("警告（単一 HTML が大きいなど）は一覧で見せる。閉じられる", async () => {
    const [assetId] = Object.keys(t.session.doc.project.assets.entries);
    await t.repo.assets(t.session.doc.project.meta.id).remove(assetId as never); // バイト列が無いアセット → 警告
    exportNow();
    const list = await screen.findByRole("list", { name: "注意" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(closed).toBe(1);
  });
});
