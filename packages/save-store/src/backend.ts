/**
 * スロット単位の生の置き場。3 つの実装（memory / IndexedDB / localStorage）はこれだけを実装し、
 * 検証・互換判定・エラー変換は `createRepository`（repository.ts）が共通で行う。
 */
export interface SlotBackend {
  /** 保存されている生の値。無ければ `undefined`。形の検証は呼び出し側。 */
  get(slot: number): Promise<unknown>;
  /** 保存に失敗したら reject する（容量超過は `isQuotaError` で判別できる例外）。 */
  put(slot: number, value: unknown): Promise<void>;
  delete(slot: number): Promise<void>;
}

/** 容量超過の例外か（`QuotaExceededError`、古い Firefox の `NS_ERROR_DOM_QUOTA_REACHED`、code 22 / 1014）。 */
export function isQuotaError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { name, code } = e as { name?: unknown; code?: unknown };
  return (typeof name === "string" && /quota/i.test(name)) || code === 22 || code === 1014;
}
