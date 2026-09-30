import type { ZodType } from "zod";

/**
 * zod スキーマから作る「フォームの設計図」。`CommandForm` / `EntityForm` / `SystemForm` が共通で使う。
 * 値の検証は zod 自身が行い、ここは「どんなウィジェットを出すか」だけを決める。
 */
export type FieldSpec =
  | { kind: "string"; ref?: string; assetKind?: string; multiline?: boolean; formula?: boolean }
  | { kind: "number"; int: boolean; min?: number; max?: number }
  | { kind: "boolean" }
  /** `labels` はスキーマのメタデータ（`.meta({ labels })`）の、値ごとの表示名。 */
  | { kind: "enum"; values: string[]; labels?: Readonly<Record<string, string>> }
  | { kind: "literal"; value: string | number | boolean }
  /** リテラルと列挙だけのユニオン（例：16 | 32 | 48、向き | "retain"）。1 つの選択肢の一覧から選ぶ。 */
  | { kind: "choice"; values: (string | number | boolean)[] }
  /** `location` はスキーマのメタデータ（`.meta({ location })`）：マップと位置のフィールド。マップをクリックして選ぶ欄が付く。 */
  | { kind: "object"; fields: ObjectField[]; location?: LocationKeys }
  | { kind: "array"; item: FieldSpec; min: number }
  /** キーが enum なら固定の行（`partial` なら行ごとに有無を選べる）、文字列なら自由なキーの行。 */
  | { kind: "record"; key: FieldSpec; value: FieldSpec; partial: boolean }
  /** `discriminator` があれば判別付きユニオン（各選択肢は discriminator を literal に持つ object）。 */
  | { kind: "union"; options: FieldSpec[]; discriminator?: string }
  /** イベントコマンドの列（`{ code, params, indent }` の配列）。専用のリスト編集が出る。 */
  | { kind: "commands" }
  | { kind: "unknown" };

export interface ObjectField {
  key: string;
  spec: FieldSpec;
  /** `.optional()`：値が無くてもよい */
  optional: boolean;
  /** `.default()`：省略すると既定値が入る */
  hasDefault: boolean;
  /** `.default()` の値（新しく追加するときの初期値に使う） */
  default?: unknown;
  /** スキーマのメタデータ（`.meta({ initial })`）：エディタで新しく作るときの初期値。検証には影響しない。 */
  initial?: unknown;
  /** スキーマのメタデータ（`.meta({ title })`）：見出し（無ければフィールド名から決める）。 */
  title?: string;
  /** スキーマのメタデータ（`.meta({ description })`）：欄の下に出す補足。 */
  description?: string;
}

/** マップと位置を表すフィールドの名前（`.meta({ location: true })` なら mapId / x / y）。 */
export interface LocationKeys {
  map: string;
  x: string;
  y: string;
}

/** zod の内部表現（`_zod.def`）を読むための最小の型。 */
interface Def {
  type: string;
  shape?: Record<string, ZodType>;
  innerType?: ZodType;
  element?: ZodType;
  options?: ZodType[];
  discriminator?: string;
  keyType?: ZodType;
  valueType?: ZodType;
  entries?: Record<string, unknown>;
  values?: unknown[];
  defaultValue?: unknown;
  checks?: { _zod: { def: { check: string; value?: number; inclusive?: boolean; format?: string } } }[];
}

const defOf = (s: ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;
const metaOf = (s: ZodType): Record<string, unknown> => (s as unknown as { meta(): Record<string, unknown> | undefined }).meta() ?? {};

/** `optional` / `default` / `nullable` の皮をむいて、中身と、外側にあった性質を返す。 */
function unwrap(schema: ZodType): { inner: ZodType; optional: boolean; hasDefault: boolean; default?: unknown } {
  let inner = schema;
  let optional = false;
  let hasDefault = false;
  let dflt: unknown;
  for (;;) {
    const def = defOf(inner);
    if (def.type === "optional" || def.type === "nullable" || def.type === "default" || def.type === "prefault" || def.type === "readonly") {
      if (def.type === "optional") optional = true;
      if (def.type === "default" || def.type === "prefault") {
        hasDefault = true;
        dflt ??= typeof def.defaultValue === "function" ? (def.defaultValue as () => unknown)() : def.defaultValue;
      }
      if (def.innerType === undefined) break;
      inner = def.innerType;
      continue;
    }
    break;
  }
  return { inner, optional, hasDefault, ...(dflt === undefined ? {} : { default: dflt }) };
}

function numberBounds(def: Def): { int: boolean; min?: number; max?: number } {
  let int = false;
  let min: number | undefined;
  let max: number | undefined;
  for (const c of def.checks ?? []) {
    const check = c._zod.def;
    if (check.check === "number_format" && (check.format === "safeint" || check.format === "int32" || check.format === "uint32")) int = true;
    if (check.check === "greater_than" && typeof check.value === "number") min = check.value;
    if (check.check === "less_than" && typeof check.value === "number") max = check.value;
  }
  return { int, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

/** スキーマ 1 つを `FieldSpec` にする。未対応の型は `unknown`（JSON 入力欄）になる。 */
export function describeSchema(schema: ZodType): FieldSpec {
  const { inner } = unwrap(schema);
  const def = defOf(inner);
  const meta = metaOf(inner);
  switch (def.type) {
    case "string":
      return {
        kind: "string",
        ...(typeof meta["ref"] === "string" ? { ref: meta["ref"] } : {}),
        ...(typeof meta["assetKind"] === "string" ? { assetKind: meta["assetKind"] } : {}),
        ...(meta["multiline"] === true ? { multiline: true } : {}),
        ...(meta["formula"] === true ? { formula: true } : {}),
      };
    case "number":
      return { kind: "number", ...numberBounds(def) };
    case "boolean":
      return { kind: "boolean" };
    case "enum": {
      const labels = meta["labels"];
      return {
        kind: "enum",
        values: Object.values(def.entries ?? {}).map(String),
        ...(typeof labels === "object" && labels !== null ? { labels: labels as Record<string, string> } : {}),
      };
    }
    case "literal": {
      const value = def.values?.[0];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? { kind: "literal", value } : { kind: "unknown" };
    }
    case "object": {
      const shape = def.shape ?? {};
      const loc = meta["location"];
      const location: LocationKeys | undefined =
        loc === true ? { map: "mapId", x: "x", y: "y" } : typeof loc === "object" && loc !== null ? (loc as LocationKeys) : undefined;
      return {
        kind: "object",
        fields: Object.entries(shape).map(([key, s]) => {
          const u = unwrap(s);
          // 皮（optional / default）の外と中、どちらに付けたメタデータも読む
          const own = { ...metaOf(u.inner), ...metaOf(s) };
          const initial = own["initial"];
          const title = own["title"];
          const description = own["description"];
          return {
            key,
            spec: describeSchema(s),
            optional: u.optional,
            hasDefault: u.hasDefault,
            ...(u.default === undefined ? {} : { default: u.default }),
            ...(initial === undefined ? {} : { initial }),
            ...(typeof title === "string" ? { title } : {}),
            ...(typeof description === "string" ? { description } : {}),
          };
        }),
        ...(location !== undefined && [location.map, location.x, location.y].every((k) => Object.hasOwn(shape, k)) ? { location } : {}),
      };
    }
    case "array": {
      const element = def.element === undefined ? undefined : defOf(def.element);
      const keys = element?.type === "object" ? Object.keys(element.shape ?? {}) : [];
      if (keys.length === 3 && ["code", "params", "indent"].every((k) => keys.includes(k))) return { kind: "commands" };
      const min = (def.checks ?? []).find((c) => c._zod.def.check === "min_length")?._zod.def as { minimum?: number } | undefined;
      return { kind: "array", item: def.element === undefined ? { kind: "unknown" } : describeSchema(def.element), min: min?.minimum ?? 0 };
    }
    case "record": {
      if (def.keyType === undefined || def.valueType === undefined) return { kind: "unknown" };
      // 空のオブジェクトを受け付ければ、キーごとに有無を選べる（partialRecord）
      const partial = (inner as unknown as { safeParse(v: unknown): { success: boolean } }).safeParse({}).success;
      return { kind: "record", key: describeSchema(def.keyType), value: describeSchema(def.valueType), partial };
    }
    case "union": {
      const options = (def.options ?? []).map(describeSchema);
      // リテラルと列挙だけなら、種類を選ばせずに 1 つの一覧にまとめる（例：向き | "retain"）
      if (options.length > 0 && options.every((o) => o.kind === "literal" || o.kind === "enum")) {
        return { kind: "choice", values: options.flatMap((o) => (o.kind === "literal" ? [o.value] : o.kind === "enum" ? o.values : [])) };
      }
      return { kind: "union", options, ...(def.discriminator === undefined ? {} : { discriminator: def.discriminator }) };
    }
    default:
      return { kind: "unknown" };
  }
}
