import type { SaveRepository, SaveRepositoryOpts } from "@rpg/runtime";
import type { SlotBackend } from "./backend.js";
import { createRepository } from "./repository.js";

/** 保存先の共有表。キーは `${projectId}:${slot}`。同じ表を渡せば、別の設定で同じ内容を開き直せる。 */
export type MemoryStore = Map<string, unknown>;

/** メモリ上の置き場。保存時に値を複製する（呼び出し側の変更が保存内容に及ばないように）。 */
export function createMemoryBackend(projectId: string, store: MemoryStore = new Map()): SlotBackend {
  const key = (slot: number): string => `${projectId}:${slot}`;
  return {
    get: (slot) => Promise.resolve(store.get(key(slot))),
    put(slot, value) {
      store.set(key(slot), structuredClone(value));
      return Promise.resolve();
    },
    delete(slot) {
      store.delete(key(slot));
      return Promise.resolve();
    },
  };
}

/** メモリ上の SaveRepository（テスト・ストレージの無い環境用）。 */
export function createMemorySaveRepository(opts: SaveRepositoryOpts & { store?: MemoryStore }): SaveRepository {
  const backend = createMemoryBackend(opts.projectId, opts.store);
  return createRepository(() => Promise.resolve(backend), opts);
}
