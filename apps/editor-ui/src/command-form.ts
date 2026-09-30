import type { FormContext } from "./schema-form/SchemaForm.js";

/** コマンドごとに標準のフォームを差し替える部品の props（プラグインも同じ仕組みで差し替える）。 */
export interface CommandFormOverrideProps {
  params: Record<string, unknown>;
  onCommit: (params: Record<string, unknown>) => void;
  ctx: FormContext;
}
