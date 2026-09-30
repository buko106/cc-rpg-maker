import { expect, test } from "@playwright/test";

// 保存先のフォルダを選べる（docs/13-editor-ui.md）。ヘッドレスではダイアログを開けないので、
// `showDirectoryPicker` を「OPFS の `picked` フォルダを返すスタブ」に差し替えて、選んだ後の流れを確かめる。
const EDITOR = "http://127.0.0.1:4174/";

test("一覧の「フォルダを選ぶ…」で保存先を切り替えると、プロジェクトがそのフォルダに <id>/project.json で保存される", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle("picked", { create: true });
    };
  });
  await page.goto(EDITOR);
  await expect(page.getByText("ブラウザ内（IndexedDB）")).toBeVisible();

  await page.getByRole("button", { name: /フォルダを選ぶ/ }).click();
  await expect(page.getByText("選んだフォルダ")).toBeVisible();
  await expect(page.getByText(/まだプロジェクトがありません/)).toBeVisible();

  await page.getByLabel("新しいプロジェクトの名前").fill("フォルダのゲーム");
  await page.getByRole("button", { name: "新規作成" }).click();
  await expect(page.getByRole("application")).toBeVisible();
  await page.getByRole("button", { name: "← プロジェクト一覧" }).click();
  await expect(page.getByRole("button", { name: "フォルダのゲーム を開く" })).toBeVisible();

  const files = (await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked");
    const out: string[] = [];
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind !== "directory") continue;
      for await (const [child] of (h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) out.push(`${name.length > 0 ? "<id>" : name}/${child}`);
    }
    return out;
  })) as string[];
  expect(files).toEqual(expect.arrayContaining(["<id>/project.json", "<id>/meta.json"]));

  // 選ぶのをやめたとき（AbortError）は何も起きない
  await page.evaluate(() => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = () => Promise.reject(new DOMException("cancelled", "AbortError"));
  });
  await page.getByRole("button", { name: /フォルダを選ぶ/ }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("選んだフォルダ")).toBeVisible();
});
