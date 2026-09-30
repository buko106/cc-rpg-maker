// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { useAssetUrl } from "./components/useAssetUrl.js";
import { FormEditor } from "./form-editor.js";
import { EnvContext, SessionContext, useEnv, useFormContext, useSession } from "./hooks.js";
import { createTestEnv } from "./test-env.js";
import type { TestEnv } from "./test-env.js";
import { cmd } from "@rpg/editor-core";
import type { AssetId, MapId } from "@rpg/schema";

let t: TestEnv;
beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
  t = await createTestEnv();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("一覧 → 新規作成 → エディタ → 一覧に戻る（保存してから）。開き直せる。削除は確認される", async () => {
    const { env, repo } = t;
    render(<App env={env} repo={repo} />);
    // 「テスト」プロジェクトが 1 つある
    await waitFor(() => expect(screen.getByRole("list", { name: "プロジェクト一覧" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("新しいプロジェクトの名前"), { target: { value: "冒険" } });
    fireEvent.click(screen.getByRole("button", { name: "新規作成" }));
    await waitFor(() => expect(screen.getByRole("application")).toBeTruthy());
    expect(screen.getByText("冒険")).toBeTruthy();

    // 編集して一覧に戻ると保存される
    const session = (window as unknown as { __editor: { execute(c: unknown): unknown; dirty: boolean } }).__editor;
    act(() => void session.execute(cmd.paintTiles("map_001" as MapId, 0, [{ x: 0, y: 0, tile: 4 }])));
    expect(session.dirty).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "← プロジェクト一覧" }));
    await waitFor(() => expect(screen.getByRole("list", { name: "プロジェクト一覧" })).toBeTruthy());
    expect(session.dirty).toBe(false);

    // 開き直すと編集内容が残っている
    fireEvent.click(screen.getByRole("button", { name: "冒険 を開く" }));
    await waitFor(() => expect(screen.getByRole("application")).toBeTruthy());
    const reopened = (window as unknown as { __editor: { doc: { maps: Record<string, { layers: { tiles: number[] }[] }> } } }).__editor;
    expect(reopened.doc.maps["map_001"]!.layers[0]!.tiles[0]).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "← プロジェクト一覧" }));
    await waitFor(() => expect(screen.getByRole("list", { name: "プロジェクト一覧" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "冒険 を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.getByText("冒険")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "冒険 を削除" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(screen.queryByText("冒険")).toBeNull());
  });

  it("保存先の名前を出し、フォルダを選ぶと一覧がそのフォルダのものに切り替わる。pickFolder が無ければボタンは出ない", async () => {
    const { env, repo } = t;
    const { unmount } = render(<App env={env} repo={repo} storageLabel="ブラウザ内" />);
    await screen.findByRole("list", { name: "プロジェクト一覧" });
    expect(screen.getByText("ブラウザ内")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /フォルダを選ぶ/ })).toBeNull();
    unmount();

    const other = { ...repo, list: () => Promise.resolve([]) };
    render(<App env={env} repo={repo} storageLabel="ブラウザ内" pickFolder={() => Promise.resolve({ repo: other, label: "選んだフォルダ" })} />);
    await screen.findByRole("list", { name: "プロジェクト一覧" });
    fireEvent.click(screen.getByRole("button", { name: /フォルダを選ぶ/ }));
    await waitFor(() => expect(screen.getByText("選んだフォルダ")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/まだプロジェクトがありません/)).toBeTruthy());
  });

  it("フォルダ選択をやめても何も起きず、失敗したら理由を出す", async () => {
    const abort = vi.fn(() => Promise.reject(new DOMException("cancelled", "AbortError")));
    const { rerender } = render(<App env={t.env} repo={t.repo} pickFolder={abort} />);
    await screen.findByRole("list", { name: "プロジェクト一覧" });
    fireEvent.click(screen.getByRole("button", { name: /フォルダを選ぶ/ }));
    await waitFor(() => expect(abort).toHaveBeenCalled());
    await act(async () => void (await Promise.resolve()));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("list", { name: "プロジェクト一覧" })).toBeTruthy();

    rerender(<App env={t.env} repo={t.repo} pickFolder={() => Promise.reject(new Error("許可されなかった"))} />);
    fireEvent.click(screen.getByRole("button", { name: /フォルダを選ぶ/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("許可されなかった"));
  });

  it("名前が空なら既定の名前。プロジェクトが無いときは案内を出す", async () => {
    await t.repo.remove(t.session.doc.project.meta.id);
    render(<App env={t.env} repo={t.repo} />);
    await waitFor(() => expect(screen.getByText(/まだプロジェクトがありません/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "新規作成" }));
    await waitFor(() => expect(screen.getByText("新しいゲーム")).toBeTruthy());
  });

  it("開けないプロジェクトはメッセージで知らせる", async () => {
    render(<App env={t.env} repo={{ ...t.repo, load: () => Promise.resolve({ ok: false, error: { kind: "notFound" } }) }} />);
    fireEvent.click(await screen.findByRole("button", { name: "テスト を開く" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("プロジェクトを開けません（notFound）"));
  });

  it("一覧の取得や作成に失敗したらメッセージを出す", async () => {
    render(<App env={t.env} repo={{ ...t.repo, list: () => Promise.reject(new Error("読めない")), create: () => Promise.reject(new Error("作れない")) }} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("読めない"));
    fireEvent.click(screen.getByRole("button", { name: "新規作成" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("作れない"));
  });

  it("競合などで保存できなければ、エディタに留まる", async () => {
    render(<App env={t.env} repo={t.repo} />);
    fireEvent.click(await screen.findByRole("button", { name: "テスト を開く" }));
    await waitFor(() => expect(screen.getByRole("application")).toBeTruthy());
    const session = (window as unknown as { __editor: { execute(c: unknown): unknown } }).__editor;
    await t.repo.save((window as unknown as { __editor: { doc: never } }).__editor.doc); // 先に保存される
    act(() => void session.execute(cmd.paintTiles("map_001" as MapId, 0, [{ x: 0, y: 0, tile: 4 }])));
    fireEvent.click(screen.getByRole("button", { name: "← プロジェクト一覧" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("他の場所で更新されています"));
    expect(screen.getByRole("application")).toBeTruthy();
  });
});

describe("hooks", () => {
  it("Provider の外で使うと例外", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useEnv())).toThrow("EnvContext");
    expect(() => renderHook(() => useSession())).toThrow("SessionContext");
    spy.mockRestore();
  });

  it("useFormContext：選択肢は文書から作られ、式の文法エラーを返す", () => {
    act(() => void t.session.execute(cmd.setSwitchName("sw_a" as never, "スイッチA")));
    const { result } = renderHook(() => useFormContext(), { wrapper: ({ children }) => <EnvContext.Provider value={t.env}><SessionContext.Provider value={t.session}>{children}</SessionContext.Provider></EnvContext.Provider> });
    const c = result.current;
    expect(c.refOptions("actor")).toEqual([{ value: "actor_001", label: "勇者（actor_001）" }]);
    expect(c.refOptions("switch")).toEqual([{ value: "sw_a", label: "スイッチA（sw_a）" }]);
    expect(c.refOptions("map")).toEqual([{ value: "map_001", label: "MAP001（map_001）" }]);
    expect(c.refOptions("asset", "image")).toHaveLength(2);
    expect(c.refOptions("asset", "audio")).toEqual([]);
    for (const kind of ["class", "skill", "item", "enemy", "troop", "state", "commonEvent", "tileset", "variable"]) expect(Array.isArray(c.refOptions(kind))).toBe(true);
    expect(c.refOptions("unknown-kind")).toEqual([]);
    expect(c.checkFormula?.("a.atk * 2")).toBeUndefined();
    expect(c.checkFormula?.("a.atk * ")).toContain("文字目");
  });
});

describe("useAssetUrl", () => {
  it("Blob URL を作り、アンマウントで解放する。IDが無ければ undefined", async () => {
    const revoked: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: (u: string) => revoked.push(u) }));
    const id = Object.keys(t.session.doc.project.assets.entries)[0] as AssetId;
    const wrapper = ({ children }: { children: React.ReactNode }) => t.wrap(children);
    const { result, unmount } = renderHook(() => useAssetUrl(id), { wrapper });
    await waitFor(() => expect(result.current).toBe("blob:x"));
    unmount();
    expect(revoked).toEqual(["blob:x"]);
    const none = renderHook(() => useAssetUrl(undefined), { wrapper });
    expect(none.result.current).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("FormEditor", () => {
  const schema = z.strictObject({ n: z.number().int().min(1), s: z.string() });

  function Host({ onCommit }: { onCommit: (v: unknown) => void }) {
    const [value, setValue] = useState<unknown>({ n: 1, s: "a" });
    return (
      <>
        <button type="button" onClick={() => setValue({ n: 9, s: "外から" })}>外から変える</button>
        <FormEditor schema={schema} value={value} ctx={{ refOptions: () => [] }} onCommit={onCommit} label="" />
      </>
    );
  }

  it("有効な入力だけ commit する。不正な間は問題を出す。外から値が変わったら追随する", () => {
    const commits: unknown[] = [];
    render(<Host onCommit={(v) => commits.push(v)} />);
    fireEvent.change(screen.getByLabelText("s"), { target: { value: "b" } });
    expect(commits).toEqual([{ n: 1, s: "b" }]);
    fireEvent.change(screen.getByLabelText("n"), { target: { value: "0" } });
    expect(commits).toHaveLength(1);
    expect(screen.getByRole("alert", { name: "入力の問題" }).textContent).toContain("n");
    fireEvent.change(screen.getByLabelText("n"), { target: { value: "5" } });
    expect(commits).toEqual([{ n: 1, s: "b" }, { n: 5, s: "b" }]);
    fireEvent.click(screen.getByRole("button", { name: "外から変える" }));
    expect((screen.getByLabelText("s") as HTMLInputElement).value).toBe("外から");
    expect((screen.getByLabelText("n") as HTMLInputElement).value).toBe("9");
    expect(commits).toHaveLength(2); // 外からの変更は commit し直さない
  });
});
