import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ZodType } from "zod";
import { describeSchema } from "./schema-form/introspect.js";
import { fieldLabel } from "./schema-form/labels.js";
import { SchemaForm } from "./schema-form/SchemaForm.js";
import type { FormContext } from "./schema-form/SchemaForm.js";

export interface FormEditorProps<T> {
  /** 値の検証に使うスキーマ。フォームもここから作る。 */
  schema: ZodType<T>;
  /** 文書にある現在の値（外から変わったら下書きも追随する）。 */
  value: unknown;
  ctx: FormContext;
  /** 検証を通った値（既定値の適用後）を受け取る。 */
  onCommit: (value: T) => void;
  label?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 問題の場所を、フォームの見出しと同じ呼び名で（`conditions.0.id` → `出現条件 1 ID`）。 */
export const issuePlace = (path: readonly PropertyKey[]): string => path.map((k) => (typeof k === "number" ? String(k + 1) : fieldLabel(String(k)))).join(" ");

/** `path` の位置の値（無ければ `undefined`）。 */
const valueAt = (value: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Record<PropertyKey, unknown>)[k] : undefined), value);

/**
 * スキーマ駆動のフォーム 1 つ。入力の途中は下書き（`draft`）として持ち、zod の検証を通ったときだけ `onCommit` する。
 * 通らない間は問題点を一覧で示し、文書には何も渡さない。Undo などで `value` が外から変わったら、下書きを差し替える。
 */
export function FormEditor<T>({ schema, value, ctx, onCommit, label = "" }: FormEditorProps<T>): ReactElement {
  const spec = useMemo(() => describeSchema(schema), [schema]);
  const [draft, setDraft] = useState<unknown>(value);
  const committed = useRef<unknown>(value);

  useEffect(() => {
    if (!same(value, committed.current)) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  const parsed = schema.safeParse(draft);
  const change = (next: unknown): void => {
    setDraft(next);
    const r = schema.safeParse(next);
    if (r.success && !same(r.data, committed.current)) {
      committed.current = r.data;
      onCommit(r.data);
    }
  };

  return (
    <SchemaForm spec={spec} value={draft} ctx={ctx} label={label} onChange={change}>
      {!parsed.success && (
        <ul className="sf-issues" role="alert" aria-label="入力の問題">
          {parsed.error.issues.map((issue, i) => (
            <li key={i}>
              {issue.path.length > 0 && <strong>{issuePlace(issue.path)}</strong>}
              {issue.path.length > 0 && "："}
              {/* 空のまま（ID を選んでいないなど）は、形式の説明より「未設定」の方が分かりやすい */}
              {valueAt(draft, issue.path) === "" ? "未設定です" : issue.message}
            </li>
          ))}
        </ul>
      )}
    </SchemaForm>
  );
}
