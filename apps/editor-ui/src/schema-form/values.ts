import type { FieldSpec } from "./introspect.js";
import { refLabel } from "./labels.js";

/** 「ID を選ぶ」ウィジェットの選択肢を返す口。 */
export interface RefOptions {
  (ref: string, assetKind?: string): { value: string; label: string }[];
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 新しく追加する値の既定。スキーマのメタデータに `initial` があればそれ、`.default()` があればその値。
 * それ以外は、ID 欄は選択肢の先頭（無ければ空文字）、配列は最小の長さぶん、union は先頭の選択肢。
 * 検証を通る値になるとは限らない（空の ID など）。通るかどうかは zod が決める。
 */
export function defaultValue(spec: FieldSpec, refOptions: RefOptions, depth = 0): unknown {
  if (depth > 6) return undefined;
  switch (spec.kind) {
    case "string":
      return spec.ref === undefined ? "" : (refOptions(spec.ref, spec.assetKind)[0]?.value ?? "");
    case "number":
      return spec.min !== undefined ? Math.max(0, spec.min) : 0;
    case "boolean":
      return false;
    case "enum":
      return spec.values[0] ?? "";
    case "literal":
      return spec.value;
    case "choice":
      return spec.values[0];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of spec.fields) {
        if (f.optional) continue;
        out[f.key] =
          f.initial !== undefined ? (JSON.parse(JSON.stringify(f.initial)) as unknown) : f.hasDefault && f.default !== undefined ? f.default : defaultValue(f.spec, refOptions, depth + 1);
      }
      return out;
    }
    case "commands":
      return [];
    case "array":
      return Array.from({ length: spec.min }, () => defaultValue(spec.item, refOptions, depth + 1));
    case "record": {
      if (spec.key.kind !== "enum" || spec.partial) return {};
      return Object.fromEntries(spec.key.values.map((k) => [k, defaultValue(spec.value, refOptions, depth + 1)]));
    }
    case "union":
      return spec.options[0] === undefined ? undefined : defaultValue(spec.options[0], refOptions, depth + 1);
    case "unknown":
      return undefined;
  }
}

/** 値がどの選択肢（union）に当たるか。当てはまらなければ 0。 */
export function matchOption(options: readonly FieldSpec[], value: unknown): number {
  const index = options.findIndex((o) => matches(o, value));
  return index < 0 ? 0 : index;
}

function matches(spec: FieldSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "string":
    case "enum":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "literal":
      return value === spec.value;
    case "choice":
      return spec.values.includes(value as never);
    case "array":
    case "commands":
      return Array.isArray(value);
    case "record":
      return isRecord(value);
    case "object":
      // literal のフィールド（判別用）が一致すること
      return isRecord(value) && spec.fields.every((f) => f.spec.kind !== "literal" || value[f.key] === f.spec.value);
    case "union":
      return spec.options.some((o) => matches(o, value));
    case "unknown":
      return true;
  }
}

/** union の選択肢の見出し（呼び出し側で `optionLabelOf` を通す）。 */
export function optionLabel(spec: FieldSpec, index: number): string {
  if (spec.kind === "object") {
    const tag = spec.fields.find((f) => f.spec.kind === "literal");
    if (tag !== undefined && tag.spec.kind === "literal") return String(tag.spec.value);
    return "構造";
  }
  if (spec.kind === "literal") return String(spec.value);
  if (spec.kind === "string") return spec.formula ? "式" : spec.ref !== undefined ? refLabel(spec.ref) : "直接入力";
  if (spec.kind === "number") return "数値";
  if (spec.kind === "boolean") return "真偽";
  return `選択肢 ${index + 1}`;
}

/** JSON 化できる値か（unknown ウィジェットの入力検査用）。 */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
