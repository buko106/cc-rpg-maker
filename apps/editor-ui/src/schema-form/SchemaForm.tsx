import { useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { EventCommand } from "@rpg/schema";
import type { FieldSpec, ObjectField } from "./introspect.js";
import { fieldLabel, optionLabelOf } from "./labels.js";
import { defaultValue, matchOption, optionLabel, tryParseJson } from "./values.js";
import type { RefOptions } from "./values.js";

/** フォームが外の世界に尋ねること。 */
export interface FormContext {
  /** ID 欄の選択肢 */
  refOptions: RefOptions;
  /** 式の文法エラー（無ければ `undefined`）。 */
  checkFormula?: (source: string) => string | undefined;
  /** イベントコマンド列の編集ウィジェット（無ければ JSON で編集する）。 */
  renderCommands?: (commands: EventCommand[], onChange: (next: EventCommand[]) => void) => ReactNode;
  /**
   * `ref` の種類の ID をその場で作る口（作れない種類なら `undefined`）。`create` は名前を受け取って作り、その ID を返す（失敗は `undefined`）。
   * ID 欄の選択肢の最後に「＋ 新しい{noun}…」が出る。
   */
  newRef?: (ref: string) => { noun: string; create: (name: string) => string | undefined } | undefined;
}

interface FieldProps {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  ctx: FormContext;
  label: string;
  /** 判別用のキーなど、見せずに保つフィールド */
  hidden?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** ID 欄の「＋ 新しい…」の値。ID には `:` を使えないので、既存の ID と重ならない。 */
const NEW_REF = ":new";

/** ID 欄の下に出る、新しく作るものの名前の入力欄。Enter か「作成」で作る。Esc か「やめる」で閉じる。 */
function NewRef({ noun, onCreate, onCancel }: { noun: string; onCreate: (name: string) => void; onCancel: () => void }): ReactElement {
  const id = useId();
  return (
    <form
      className="sf-newref"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate((e.currentTarget.elements.namedItem(id) as HTMLInputElement).value.trim());
      }}
    >
      <input
        name={id}
        type="text"
        aria-label={`新しい${noun}の名前`}
        placeholder={`新しい${noun}の名前`}
        autoFocus
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation(); // ダイアログは閉じない
          onCancel();
        }}
      />
      <button type="submit">作成</button>
      <button type="button" onClick={onCancel}>
        やめる
      </button>
    </form>
  );
}

function StringField({ spec, value, onChange, ctx, label }: FieldProps & { spec: Extract<FieldSpec, { kind: "string" }> }): ReactElement {
  const [creating, setCreating] = useState(false);
  const text = typeof value === "string" ? value : "";
  if (spec.ref !== undefined) {
    const options = ctx.refOptions(spec.ref, spec.assetKind);
    const known = options.some((o) => o.value === text);
    const creator = ctx.newRef?.(spec.ref);
    return (
      <>
        <select aria-label={label} value={text} onChange={(e) => (e.target.value === NEW_REF ? setCreating(true) : onChange(e.target.value))}>
          {!known && <option value={text}>{text === "" ? "（選択してください）" : `${text}（存在しない）`}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {creator !== undefined && <option value={NEW_REF}>＋ 新しい{creator.noun}…</option>}
        </select>
        {creating && creator !== undefined && (
          <NewRef
            noun={creator.noun}
            onCancel={() => setCreating(false)}
            onCreate={(name) => {
              const created = creator.create(name);
              if (created === undefined) return;
              setCreating(false);
              onChange(created);
            }}
          />
        )}
      </>
    );
  }
  if (spec.multiline === true) return <textarea aria-label={label} rows={4} value={text} onChange={(e) => onChange(e.target.value)} />;
  const problem = spec.formula === true && text !== "" ? ctx.checkFormula?.(text) : undefined;
  return (
    <>
      <input aria-label={label} type="text" value={text} onChange={(e) => onChange(e.target.value)} {...(problem === undefined ? {} : { "aria-invalid": true })} />
      {problem !== undefined && <small role="alert" className="sf-error">式のエラー：{problem}</small>}
    </>
  );
}

function ArrayField({ spec, value, onChange, ctx, label }: FieldProps & { spec: Extract<FieldSpec, { kind: "array" }> }): ReactElement {
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const set = (next: unknown[]): void => onChange(next);
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set(next);
  };
  return (
    <div className="sf-array">
      {items.map((item, i) => (
        <div className="sf-array-item" key={i} role="group" aria-label={`${label} ${i + 1}`}>
          <div className="sf-array-body">
            <Field spec={spec.item} value={item} label={`${label} ${i + 1}`} ctx={ctx} onChange={(v) => set(items.map((x, j) => (j === i ? v : x)))} />
          </div>
          <div className="sf-array-actions">
            <button type="button" aria-label={`${label} ${i + 1} を上へ`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
            <button type="button" aria-label={`${label} ${i + 1} を下へ`} disabled={i === items.length - 1} onClick={() => move(i, i + 1)}>↓</button>
            <button type="button" aria-label={`${label} ${i + 1} を削除`} disabled={items.length <= spec.min} onClick={() => set(items.filter((_, j) => j !== i))}>削除</button>
          </div>
        </div>
      ))}
      <button type="button" className="sf-add" onClick={() => set([...items, defaultValue(spec.item, ctx.refOptions)])}>
        ＋ {label}を追加
      </button>
    </div>
  );
}

function RecordField({ spec, value, onChange, ctx, label }: FieldProps & { spec: Extract<FieldSpec, { kind: "record" }> }): ReactElement {
  const obj = isRecord(value) ? value : {};
  if (spec.key.kind === "enum") {
    return (
      <div className="sf-record">
        {spec.key.values.map((key) => {
          const present = Object.hasOwn(obj, key);
          const rowLabel = `${label} ${fieldLabel(key)}`;
          return (
            <div className="sf-row" key={key}>
              {spec.partial && (
                <input
                  type="checkbox"
                  aria-label={`${rowLabel}を設定`}
                  checked={present}
                  onChange={(e) => {
                    const next = { ...obj };
                    if (e.target.checked) next[key] = defaultValue(spec.value, ctx.refOptions);
                    else delete next[key];
                    onChange(next);
                  }}
                />
              )}
              <span className="sf-key">{fieldLabel(key)}</span>
              {(present || !spec.partial) && <Field spec={spec.value} value={obj[key]} label={rowLabel} ctx={ctx} onChange={(v) => onChange({ ...obj, [key]: v })} />}
            </div>
          );
        })}
      </div>
    );
  }
  const keys = Object.keys(obj);
  return (
    <div className="sf-record">
      {keys.map((key) => (
        <div className="sf-row" key={key}>
          <span className="sf-key">{key}</span>
          <Field spec={spec.value} value={obj[key]} label={`${label} ${key}`} ctx={ctx} onChange={(v) => onChange({ ...obj, [key]: v })} />
          <button
            type="button"
            aria-label={`${label} ${key} を削除`}
            onClick={() => {
              const next = { ...obj };
              delete next[key];
              onChange(next);
            }}
          >
            削除
          </button>
        </div>
      ))}
      <NewKey label={label} taken={keys} onAdd={(key) => onChange({ ...obj, [key]: defaultValue(spec.value, ctx.refOptions) })} />
    </div>
  );
}

/** 自由なキーを追加する小さな入力欄。 */
function NewKey({ label, taken, onAdd }: { label: string; taken: string[]; onAdd: (key: string) => void }): ReactElement {
  const id = useId();
  return (
    <form
      className="sf-newkey"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem(id) as HTMLInputElement;
        const key = input.value.trim();
        if (key !== "" && !taken.includes(key)) {
          onAdd(key);
          input.value = "";
        }
      }}
    >
      <input name={id} type="text" aria-label={`${label}の新しいキー`} />
      <button type="submit">＋ 追加</button>
    </form>
  );
}

function UnionField({ spec, value, onChange, ctx, label }: FieldProps & { spec: Extract<FieldSpec, { kind: "union" }> }): ReactElement {
  const current = matchOption(spec.options, value);
  const option = spec.options[current];
  return (
    <div className="sf-union">
      {spec.options.length > 1 && (
        <select
          aria-label={`${label}の種類`}
          value={current}
          onChange={(e) => {
            const next = spec.options[Number(e.target.value)];
            if (next !== undefined) onChange(defaultValue(next, ctx.refOptions));
          }}
        >
          {spec.options.map((o, i) => {
            const text = optionLabel(o, i);
            return (
              <option key={i} value={i}>
                {optionLabelOf(text)}
              </option>
            );
          })}
        </select>
      )}
      {option !== undefined && <Field spec={option} value={value} label={label} ctx={ctx} onChange={onChange} />}
    </div>
  );
}

function ObjectFieldRow({ field, obj, onChange, ctx, parentLabel }: { field: ObjectField; obj: Record<string, unknown>; onChange: (v: unknown) => void; ctx: FormContext; parentLabel: string }): ReactElement | null {
  if (field.spec.kind === "literal") return null;
  const label = fieldLabel(field.key);
  const fullLabel = parentLabel === "" ? label : `${parentLabel} ${label}`;
  const present = Object.hasOwn(obj, field.key) && obj[field.key] !== undefined;
  const set = (v: unknown): void => onChange({ ...obj, [field.key]: v });
  const toggle = (on: boolean): void => {
    const next = { ...obj };
    if (on) next[field.key] = defaultValue(field.spec, ctx.refOptions);
    else delete next[field.key];
    onChange(next);
  };
  const block = field.spec.kind === "object" || field.spec.kind === "array" || field.spec.kind === "record" || field.spec.kind === "union";
  return (
    <div className={block ? "sf-row sf-block" : "sf-row"}>
      {field.optional ? (
        <label className="sf-label">
          <input type="checkbox" aria-label={`${fullLabel}を設定`} checked={present} onChange={(e) => toggle(e.target.checked)} />
          {label}
        </label>
      ) : (
        <span className="sf-label">{label}</span>
      )}
      {(present || !field.optional) && <Field spec={field.spec} value={obj[field.key]} label={fullLabel} ctx={ctx} onChange={set} />}
    </div>
  );
}

function ObjectFields({ spec, value, onChange, ctx, label }: FieldProps & { spec: Extract<FieldSpec, { kind: "object" }> }): ReactElement {
  const obj = isRecord(value) ? value : {};
  return (
    <div className="sf-object" role="group" aria-label={label === "" ? undefined : label}>
      {spec.fields.map((f) => (
        <ObjectFieldRow key={f.key} field={f} obj={obj} onChange={onChange} ctx={ctx} parentLabel={label} />
      ))}
    </div>
  );
}

function Field(props: FieldProps): ReactElement | null {
  const { spec, value, onChange, label } = props;
  switch (spec.kind) {
    case "string":
      return <StringField {...props} spec={spec} />;
    case "number": {
      const shown = typeof value === "number" && !Number.isNaN(value) ? value : "";
      return (
        <input
          aria-label={label}
          type="number"
          step={spec.int ? 1 : "any"}
          {...(spec.min === undefined ? {} : { min: spec.min })}
          {...(spec.max === undefined ? {} : { max: spec.max })}
          value={shown}
          onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        />
      );
    }
    case "boolean":
      return <input aria-label={label} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case "enum":
      return (
        <select aria-label={label} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          {spec.values.map((v) => (
            <option key={v} value={v}>
              {spec.labels?.[v] ?? optionLabelOf(v)}
            </option>
          ))}
        </select>
      );
    case "choice":
      return (
        <select aria-label={label} value={String(spec.values.indexOf(value as never))} onChange={(e) => onChange(spec.values[Number(e.target.value)])}>
          {spec.values.map((v, i) => (
            <option key={i} value={i}>
              {typeof v === "string" ? optionLabelOf(v) : String(v)}
            </option>
          ))}
        </select>
      );
    case "literal":
      return null;
    case "object":
      return <ObjectFields {...props} spec={spec} />;
    case "array":
      return <ArrayField {...props} spec={spec} />;
    case "record":
      return <RecordField {...props} spec={spec} />;
    case "union":
      return <UnionField {...props} spec={spec} />;
    case "commands":
      return props.ctx.renderCommands === undefined ? (
        <JsonField value={value} onChange={onChange} label={label} />
      ) : (
        <>{props.ctx.renderCommands(Array.isArray(value) ? (value as EventCommand[]) : [], onChange)}</>
      );
    case "unknown":
      return <JsonField value={value} onChange={onChange} label={label} />;
  }
}

/** 対応していない型：JSON をそのまま編集する。 */
function JsonField({ value, onChange, label }: { value: unknown; onChange: (v: unknown) => void; label: string }): ReactElement {
  const shown = JSON.stringify(value ?? null, null, 1);
  return (
    <textarea
      aria-label={`${label}（JSON）`}
      rows={3}
      defaultValue={shown}
      onChange={(e) => {
        const parsed = tryParseJson(e.target.value);
        if (parsed.ok) onChange(parsed.value);
      }}
    />
  );
}

export interface SchemaFormProps {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  ctx: FormContext;
  /** ルートに付けるアクセシブルな名前 */
  label?: string;
  children?: ReactNode;
}

/** スキーマの設計図から作るフォーム。値は制御コンポーネントとして親が持つ。 */
export function SchemaForm({ spec, value, onChange, ctx, label = "", children }: SchemaFormProps): ReactElement {
  return (
    <div className="schema-form">
      <Field spec={spec} value={value} onChange={onChange} ctx={ctx} label={label} />
      {children}
    </div>
  );
}
