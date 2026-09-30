import type { AssetId } from "@rpg/runtime";
import type { AssetBytesSource } from "./bytes-source.js";

/**
 * OPFS（または File System Access API）のフォルダにある `<AssetId>.<ext>` を読む `AssetBytesSource`。
 * フォルダは呼び出しのたびに走査する（エディタが書き足したファイルがすぐ見える）。
 */
export function createOpfsBytesSource(dir: FileSystemDirectoryHandle): AssetBytesSource {
  const find = async (id: AssetId): Promise<FileSystemFileHandle | undefined> => {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && (name === id || name.startsWith(`${id}.`))) return handle as FileSystemFileHandle;
    }
    return undefined;
  };
  return {
    async getBytes(id) {
      const handle = await find(id);
      return handle === undefined ? undefined : (await handle.getFile()).arrayBuffer();
    },
    async has(id) {
      return (await find(id)) !== undefined;
    },
  };
}
