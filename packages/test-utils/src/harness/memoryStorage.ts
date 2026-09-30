/** Node 用の `Storage`（localStorage の代わり）。`failSet` を設定すると `setItem` がその例外を投げる（容量超過の再現用）。 */
export interface MemoryStorage extends Storage {
  failSet: Error | undefined;
  /** 保存されているキー（テストでの検査・改ざん用）。 */
  readonly data: Map<string, string>;
}

export function createMemoryStorage(): MemoryStorage {
  const data = new Map<string, string>();
  const storage: MemoryStorage = {
    failSet: undefined,
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem(k, v) {
      if (storage.failSet !== undefined) throw storage.failSet;
      data.set(k, v);
    },
  };
  return storage;
}

/** 容量超過の例外（ブラウザの `QuotaExceededError` 相当）。 */
export function quotaError(): Error {
  const e = new Error("The quota has been exceeded.");
  e.name = "QuotaExceededError";
  return e;
}
