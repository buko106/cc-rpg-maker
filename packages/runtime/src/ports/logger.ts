/** ランタイムのログ出力先。既定は何もしない（`console` を core/runtime から直接使わない）。 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
