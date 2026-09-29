/**
 * フレーム駆動のポート。ブラウザでは requestAnimationFrame、テストでは手動（test-utils の manualScheduler）。
 * runtime は DOM に依存しないため、rAF は必ずこのポート経由で使う。
 */
export interface Scheduler {
  /** 次のフレームで一度だけ `cb` を呼ぶ。返り値は cancel 関数。 */
  requestFrame(cb: (nowMs: number) => void): () => void;
  /** 現在時刻（ms）。 */
  now(): number;
}
