import { createProjectView } from "@rpg/core";
import type { CommandHandler } from "@rpg/core";
import { blockOwner, commandTemplate, copyRows, insertionPoint, isPart, moveSpan, pasteRows, removalRange, selectionSpan, splitMessages, syncDividers, withRecentCommand } from "@rpg/editor-core";
import type { CommandOp } from "@rpg/editor-core";
import type { EventCommand } from "@rpg/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { FormEditor } from "../form-editor.js";
import { useFormContext } from "../form-context.js";
import { useEnv, useSession } from "../hooks.js";
import { describeSchema } from "../schema-form/introspect.js";
import { defaultValue } from "../schema-form/values.js";
import { Dialog } from "./Dialog.js";

export interface CommandListProps {
  commands: readonly EventCommand[];
  /** 編集操作（挿入・削除・差し替え）を順に適用する。複数のときは 1 回の Undo で戻せるようにまとめる。`label` は Undo の見出し（並べ替え・貼り付けなど）。 */
  onEdit(ops: CommandOp[], label?: string): void;
}

/** IME で変換中の Enter（確定のための Enter）か。 */
const composing = (e: KeyboardEvent<HTMLElement>): boolean => e.nativeEvent.isComposing || e.keyCode === 229;

/**
 * 追加できるコマンドの一覧（分岐の区切り・終端は、対になるコマンドと一緒に入るので出さない）。
 * 上の欄に打つと名前・分類で絞り込み、Enter で先頭のものを追加する。絞り込んでいないときは「最近使ったもの」を上に出す。
 */
function CommandPicker({ onPick, onClose }: { onPick: (code: string) => void; onClose: () => void }): ReactElement {
  const env = useEnv();
  const session = useSession();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const all = env.commands.list().filter((h) => !isPart(env.commands, h.code));
  const hits = q === "" ? all : all.filter((h) => [h.meta.label, h.meta.category, h.code].some((t) => t.toLowerCase().includes(q)));
  const recent = q === "" ? session.ui.recentCommands.map((code) => all.find((h) => h.code === code)).filter((h): h is CommandHandler => h !== undefined) : [];
  const groups = new Map<string, { code: string; label: string }[]>();
  for (const h of hits) {
    const list = groups.get(h.meta.category) ?? [];
    list.push({ code: h.code, label: h.meta.label });
    groups.set(h.meta.category, list);
  }
  return (
    <Dialog title="コマンドの追加" onClose={onClose}>
      <input
        type="search"
        className="picker-search"
        aria-label="コマンドを絞り込む"
        placeholder="名前で絞り込む（Enter で先頭のコマンドを追加）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || composing(e)) return;
          e.preventDefault();
          const first = hits[0];
          if (first !== undefined) onPick(first.code);
        }}
      />
      {recent.length > 0 && (
        <section aria-label="最近使ったもの">
          <h3>最近使ったもの</h3>
          <div className="picker-grid">
            {recent.map((h) => (
              <button key={h.code} type="button" aria-label={`最近使った ${h.meta.label}`} onClick={() => onPick(h.code)}>
                {h.meta.label}
              </button>
            ))}
          </div>
        </section>
      )}
      {hits.length === 0 && <p className="muted">「{query}」に当てはまるコマンドはありません。</p>}
      {[...groups].map(([category, items]) => (
        <section key={category} aria-label={category}>
          <h3>{category}</h3>
          <div className="picker-grid">
            {items.map((it) => (
              <button key={it.code} type="button" onClick={() => onPick(it.code)}>
                {it.label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </Dialog>
  );
}

/** 1 コマンドの設定フォーム（`formOverrides` にあればそれ、無ければ params の zod から自動生成）。 */
export function CommandForm({ command, onCommit }: { command: EventCommand; onCommit: (params: Record<string, unknown>) => void }): ReactElement {
  const env = useEnv();
  const ctx = useFormContext();
  const handler = env.commands.get(command.code);
  if (handler === undefined) return <p role="alert">未知のコマンド {command.code} は編集できません。</p>;
  const Override = env.formOverrides[command.code];
  if (Override !== undefined) return <Override params={command.params} onCommit={onCommit} ctx={ctx} />;
  const parsed = handler.params.safeParse(command.params);
  return (
    <FormEditor
      key={command.code}
      schema={handler.params}
      value={parsed.success ? parsed.data : command.params}
      ctx={ctx}
      label=""
      onCommit={(params) => onCommit(params as Record<string, unknown>)}
    />
  );
}

/**
 * 「文章をすぐ追加」の欄。Enter で「文章の表示」を入れる（Shift+Enter で改行、IME の確定の Enter では入れない）。
 * 空行で区切ると、区切りごとに別々の「文章の表示」になる。
 */
function QuickText({ onAdd }: { onAdd: (texts: string[]) => void }): ReactElement {
  const [text, setText] = useState("");
  const submit = (): void => {
    const texts = splitMessages(text);
    if (texts.length === 0) return;
    onAdd(texts);
    setText("");
  };
  return (
    <div className="quick-text">
      <textarea
        aria-label="文章をすぐ追加"
        rows={2}
        placeholder="文章を打って Enter で追加（Shift+Enter で改行。空行で区切ると別々の文章になる）"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || composing(e)) return;
          e.preventDefault();
          submit();
        }}
      />
      <button type="button" disabled={splitMessages(text).length === 0} onClick={submit}>
        文章を追加
      </button>
    </div>
  );
}

/** フォームの最初の入力欄にフォーカスする（文字の欄は中身を選択して、すぐ打ち替えられるようにする）。 */
function focusFirstField(root: HTMLElement | null): void {
  const field = root?.querySelector<HTMLElement>("textarea, input:not([type=checkbox]), select");
  field?.focus();
  if (field instanceof HTMLInputElement && field.type === "text") field.select();
}

/**
 * イベントコマンドのリスト。行を選んで「追加」「編集」「削除」「並べ替え」「コピー」する。
 * 矢印キーで行を移動（Shift で範囲を選ぶ）、Enter で編集、Delete で削除、Alt+↑↓ で並べ替え、Ctrl/⌘+C・X・V でコピー・切り取り・貼り付け。
 * 分岐・ループの開始の行を選ぶと、削除・並べ替え・コピーはブロック全体が対象になる（範囲選択もブロックを切らない）。
 * 文書の変更は親が渡す `onEdit` を通して行う。
 * コマンドを追加すると設定のフォームが開き、最初の欄にフォーカスが移る。下の欄からは「文章の表示」を続けて入れられる。
 */
export function CommandList({ commands, onEdit }: CommandListProps): ReactElement {
  const env = useEnv();
  const session = useSession();
  const ctx = useFormContext();
  const reg = env.commands;
  /** 選んでいる行（範囲選択のときは、動かしている側の端）。 */
  const [selected, setSelected] = useState<number | undefined>();
  /** 範囲選択の起点（Shift+クリック・Shift+矢印で選び始めた行）。 */
  const [anchor, setAnchor] = useState<number | undefined>();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  /** 追加した直後：設定のフォームが描かれたら最初の欄にフォーカスする。 */
  const [focusEditor, setFocusEditor] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const view = useMemo(() => createProjectView(session.doc.project, session.doc.maps), [session.doc.project, session.doc.maps]);

  /** 範囲選択しているときの範囲（ブロックを切らないよう広げたもの）。 */
  const range = selected !== undefined && anchor !== undefined && anchor !== selected ? selectionSpan(reg, commands, anchor, selected) : undefined;
  /** 削除・並べ替え・コピーの対象：範囲選択ならその範囲、そうでなければ選んでいる行（開始の行ならブロック全体）。区切り・終端の行だけを選んでいるときは無い。 */
  const target = range ?? (selected === undefined ? undefined : removalRange(reg, commands, selected));
  const inTarget = (i: number): boolean => target !== undefined && i >= target.at && i < target.at + target.count;
  const clipboard = session.ui.commandClipboard;
  const canMove = (dir: "up" | "down"): boolean => target !== undefined && moveSpan(reg, commands, target, dir) !== undefined;

  /** 分岐（`ChoiceBranch` など）の行は、開始行のコマンドの `branchLabel`（「[はい] のとき」など）で見出しを付ける。 */
  const branchHeading = (i: number): string | undefined => {
    const row = commands[i]!;
    const index = row.params["index"];
    const at = blockOwner(reg, commands, i);
    if (typeof index !== "number" || at === undefined) return undefined;
    const owner = commands[at]!;
    const h = reg.get(owner.code);
    const p = h?.params.safeParse(owner.params);
    return h?.meta.branchLabel !== undefined && p?.success === true ? h.meta.branchLabel(p.data, index) : undefined;
  };

  const describe = (c: EventCommand, i: number): string => {
    const h = reg.get(c.code);
    if (h === undefined) return `？ ${c.code}`;
    if (h.meta.block?.role === "divider") {
      const heading = branchHeading(i);
      if (heading !== undefined) return heading;
    }
    const p = h.params.safeParse(c.params);
    return p.success ? h.meta.describe(p.data, view) : `${h.meta.label}（設定が不正）`;
  };

  /** 行を選ぶ。`extend` なら、選んでいた行からの範囲選択にする。 */
  const select = (i: number, extend: boolean): void => {
    if (extend && selected !== undefined) {
      setAnchor((a) => a ?? selected);
      setEditing(false);
    } else setAnchor(undefined);
    setSelected(i);
  };

  const add = (code: string): void => {
    const h = reg.get(code);
    if (h === undefined) return;
    const point = insertionPoint(reg, commands, selected);
    const raw = defaultValue(describeSchema(h.params), ctx.refOptions) ?? {};
    const parsed = h.params.safeParse(raw);
    onEdit([{ op: "insert", at: point.at, commands: commandTemplate(reg, code, (parsed.success ? parsed.data : raw) as Record<string, unknown>, point.indent) }]);
    session.setUi({ recentCommands: withRecentCommand(session.ui.recentCommands, code) });
    setSelected(point.at);
    setAnchor(undefined);
    setPicking(false);
    setEditing(true);
    setFocusEditor(true);
  };

  useEffect(() => {
    if (!focusEditor || !editing) return;
    focusFirstField(editorRef.current);
    setFocusEditor(false);
  }, [focusEditor, editing, selected]);

  /** 「文章をすぐ追加」：選択中の行の直後に「文章の表示」を並べて入れ、最後の 1 つを選ぶ（続けて入れると後ろに並ぶ）。 */
  const addTexts = (texts: string[]): void => {
    const h = reg.get("ShowText");
    if (h === undefined) return;
    const point = insertionPoint(reg, commands, selected);
    const rows = texts.map((text): EventCommand => {
      const parsed = h.params.safeParse({ text });
      return { code: "ShowText", params: (parsed.success ? parsed.data : { text }) as Record<string, unknown>, indent: point.indent };
    });
    onEdit([{ op: "insert", at: point.at, commands: rows }]);
    setSelected(point.at + rows.length - 1);
    setAnchor(undefined);
    setEditing(false);
  };

  const remove = (): void => {
    if (target === undefined) return;
    onEdit([{ op: "remove", at: target.at, count: target.count }]);
    setSelected(undefined);
    setAnchor(undefined);
    setEditing(false);
  };

  /** 1 つ前・後のひとかたまり（ブロックなら全体）と入れ替える。選択も一緒に動く。 */
  const move = (dir: "up" | "down"): void => {
    if (target === undefined || selected === undefined) return;
    const moved = moveSpan(reg, commands, target, dir);
    if (moved === undefined) return;
    onEdit(moved.ops, "コマンドの移動");
    const delta = moved.span.at - target.at;
    setSelected(selected + delta);
    setAnchor(anchor === undefined ? undefined : anchor + delta);
  };

  /** 選んでいる行（範囲・ブロック）をクリップボードに入れる（文書には入れない。ほかのイベントやページにも貼れる）。 */
  const copy = (): void => {
    if (target !== undefined) session.setUi({ commandClipboard: copyRows(commands, target) });
  };

  const cut = (): void => {
    if (target === undefined) return;
    copy();
    onEdit([{ op: "remove", at: target.at, count: target.count }], "コマンドの切り取り");
    setSelected(undefined);
    setAnchor(undefined);
    setEditing(false);
  };

  /** クリップボードの行を、選んでいる行の直後（開始の行ならブロックの中。範囲選択なら範囲の後ろ）に入れ、入れた行を選ぶ。 */
  const paste = (): void => {
    if (clipboard === undefined || clipboard.length === 0) return;
    const after = range === undefined ? selected : range.at + range.count - 1;
    const point = insertionPoint(reg, commands, after);
    onEdit([{ op: "insert", at: point.at, commands: pasteRows(clipboard, point.indent) }], "コマンドの貼り付け");
    setSelected(point.at + clipboard.length - 1);
    setAnchor(clipboard.length > 1 ? point.at : undefined);
    setEditing(false);
  };

  /** 設定フォームの確定。選択肢の数など、区切りの数が変わったら、対になる区切りの数も合わせる。 */
  const commit = (index: number, command: EventCommand, params: Record<string, unknown>): void => {
    const next = { ...command, params };
    onEdit([{ op: "replace", at: index, command: next }, ...syncDividers(reg, commands, index, params)]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    // 入力欄（設定のフォーム・文章をすぐ追加）の中のキーは、行の操作にしない
    if (e.target instanceof HTMLElement && e.target.closest(".command-editor, input, textarea, select") !== null) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    const key = e.key.toLowerCase();
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) move(e.key === "ArrowUp" ? "up" : "down");
    else if (mod && key === "c") copy();
    else if (mod && key === "x") cut();
    else if (mod && key === "v") paste();
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.key === "ArrowDown" && commands.length > 0) select(Math.min(commands.length - 1, (selected ?? -1) + 1), e.shiftKey);
    else if (e.key === "ArrowUp" && commands.length > 0) select(Math.max(0, (selected ?? commands.length) - 1), e.shiftKey);
    else if (e.key === "Enter" && selected !== undefined && range === undefined) setEditing(true);
    else if (e.key === "Delete" && target !== undefined) remove();
    else return;
    e.preventDefault();
  };

  const current = range === undefined && selected !== undefined ? commands[selected] : undefined;
  const count = target?.count ?? 0;
  return (
    <div className="command-list" onKeyDown={onKeyDown}>
      <ol role="listbox" aria-label="イベントコマンド" aria-multiselectable="true" tabIndex={0} aria-activedescendant={selected === undefined ? undefined : `cmd-row-${selected}`}>
        {commands.map((c, i) => {
          const chosen = selected === i || (range !== undefined && inTarget(i));
          return (
            <li
              key={i}
              id={`cmd-row-${i}`}
              role="option"
              aria-selected={chosen}
              className={chosen ? "selected" : count > 1 && inTarget(i) ? "in-block" : undefined}
              style={{ paddingLeft: `${c.indent * 18 + 8}px` }}
              onClick={(e) => select(i, e.shiftKey)}
              onDoubleClick={() => {
                select(i, false);
                setEditing(true);
              }}
            >
              {describe(c, i)}
            </li>
          );
        })}
        {commands.length === 0 && <li className="empty">（コマンドなし）</li>}
      </ol>
      <div className="command-actions">
        <button type="button" onClick={() => setPicking(true)}>
          コマンドを追加…
        </button>
        <button type="button" disabled={current === undefined} onClick={() => setEditing((v) => !v)}>
          {editing ? "編集を閉じる" : "編集"}
        </button>
        <button type="button" disabled={target === undefined} onClick={remove}>
          削除
        </button>
        <button type="button" aria-label="コマンドを上へ" title="1 つ上へ（Alt+↑）" disabled={!canMove("up")} onClick={() => move("up")}>
          ↑ 上へ
        </button>
        <button type="button" aria-label="コマンドを下へ" title="1 つ下へ（Alt+↓）" disabled={!canMove("down")} onClick={() => move("down")}>
          ↓ 下へ
        </button>
        <button type="button" aria-label="コマンドをコピー" title="コピー（Ctrl+C）" disabled={target === undefined} onClick={copy}>
          コピー
        </button>
        <button type="button" aria-label="コマンドを切り取り" title="切り取り（Ctrl+X）" disabled={target === undefined} onClick={cut}>
          切り取り
        </button>
        <button type="button" aria-label="コマンドを貼り付け" title="選んでいる行の後ろに貼り付け（Ctrl+V）" disabled={clipboard === undefined || clipboard.length === 0} onClick={paste}>
          貼り付け
        </button>
        <span className="muted" role="status">
          {count > 1 && `${count} 行を選択中`}
          {count > 1 && clipboard !== undefined && "　"}
          {clipboard !== undefined && `クリップボード：${clipboard.length} 行`}
        </span>
      </div>
      <p className="muted command-hint">Shift+クリック（Shift+↑↓）で複数の行を選べます。分岐・ループの開始を選ぶと、ブロックごと動かす・コピーする・消します。</p>
      <QuickText onAdd={addTexts} />
      {picking && <CommandPicker onPick={add} onClose={() => setPicking(false)} />}
      {editing && current !== undefined && selected !== undefined && (
        <div className="command-editor" aria-label="コマンドの設定" ref={editorRef}>
          <h4>{reg.get(current.code)?.meta.label ?? current.code}</h4>
          <CommandForm command={current} onCommit={(params) => commit(selected, current, params)} />
        </div>
      )}
    </div>
  );
}
