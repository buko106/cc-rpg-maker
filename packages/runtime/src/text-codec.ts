/** 制御文字の展開に必要な状態の読み取り口。 */
export interface TextEnv {
  variable(id: string): number;
  actorName(id: string): string | undefined;
}

/** 同じ色番号が続く文字列。`color` は `\C[n]` の `n`（0 = 標準）。 */
export interface ColoredText {
  readonly text: string;
  readonly color: number;
}

const CODE = /^\\([VvNnCc])\[([A-Za-z0-9_-]{1,64})\]/;

/**
 * メッセージ文字列を行ごとの色付き断片に展開する（投影時に行う。docs/06-runtime.md）。
 * - `\V[id]`：変数の値（未定義は 0）、`\N[id]`：アクター名（未定義は空）、`\C[n]`：以降の色番号
 * - `\\`：バックスラッシュ。それ以外の `\` はそのまま残す（壊れた制御文字でメッセージを止めない）
 * - 改行文字で行を分ける
 */
export function expandText(src: string, env: TextEnv): ColoredText[][] {
  const lines: ColoredText[][] = [[]];
  let color = 0;
  let buf = "";
  const flush = (): void => {
    if (buf !== "") lines[lines.length - 1]!.push({ text: buf, color });
    buf = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\n") {
      flush();
      lines.push([]);
      i++;
    } else if (ch === "\\") {
      if (src[i + 1] === "\\") {
        buf += "\\";
        i += 2;
        continue;
      }
      const m = CODE.exec(src.slice(i, i + 72));
      if (m === null) {
        buf += ch;
        i++;
        continue;
      }
      const kind = m[1]!.toUpperCase();
      const arg = m[2]!;
      if (kind === "V") buf += String(env.variable(arg));
      else if (kind === "N") buf += env.actorName(arg) ?? "";
      else {
        flush();
        color = /^\d+$/.test(arg) ? Number(arg) : 0;
      }
      i += m[0].length;
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  return lines;
}
