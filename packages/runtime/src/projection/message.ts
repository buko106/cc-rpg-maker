import type { GameState } from "@rpg/core";
import type { SystemSettings } from "@rpg/schema";
import type { UiNode } from "../frame-spec.js";
import { expandText } from "../text-codec.js";
import { FACE_SIZE, MESSAGE_FONT, MESSAGE_LINE_HEIGHT, MESSAGE_LINES, MESSAGE_MARGIN, MESSAGE_PADDING, textColor, UI_ROW_HEIGHT } from "./theme.js";
import { cursorNode, firstVisible, textNode, windowNode } from "./ui.js";

/**
 * メッセージウィンドウの投影。閉じていれば空。制御文字（`\V` `\N` `\C`）をここで展開する。
 * 表示は先頭 4 行まで（ページ送りは未対応）。
 */
export function projectMessage(state: GameState, actorName: (id: string) => string | undefined, screen: SystemSettings["screen"]): UiNode[] {
  const msg = state.message;
  if (!msg.open) return [];

  const lines = expandText(msg.text, {
    variable: (id) => (Object.hasOwn(state.variables, id) ? state.variables[id as keyof typeof state.variables] ?? 0 : 0),
    actorName,
  }).slice(0, MESSAGE_LINES);

  if (msg.choices !== null) return projectChoices(msg, lines, screen);
  if (msg.numberInput !== undefined) return projectNumberInput(msg, lines, screen);

  const w = screen.width - MESSAGE_MARGIN * 2;
  const h = MESSAGE_LINES * MESSAGE_LINE_HEIGHT + MESSAGE_PADDING * 2;
  const x = MESSAGE_MARGIN;
  const y =
    msg.position === "top" ? MESSAGE_MARGIN : msg.position === "middle" ? Math.round((screen.height - h) / 2) : screen.height - MESSAGE_MARGIN - h;

  const textX = x + MESSAGE_PADDING + (msg.face ? FACE_SIZE + MESSAGE_PADDING : 0);
  const children: UiNode[] = [];
  if (msg.face) children.push({ kind: "image", x: x + MESSAGE_PADDING, y: y + MESSAGE_PADDING, asset: msg.face.asset, sx: 0, sy: 0, sw: FACE_SIZE, sh: FACE_SIZE });
  lines.forEach((line, row) => {
    if (line.length === 0) return;
    const ty = y + MESSAGE_PADDING + row * MESSAGE_LINE_HEIGHT;
    const first = line[0]!;
    children.push({
      kind: "text",
      x: textX,
      y: ty,
      text: line.map((r) => r.text).join(""),
      font: MESSAGE_FONT,
      color: textColor(first.color),
      ...(line.length > 1 ? { runs: line.map((r) => ({ text: r.text, color: textColor(r.color) })) } : {}),
    });
  });

  if (msg.background === "transparent") return children;
  return [{ kind: "window", x, y, w, h, variant: msg.background === "dim" ? "dim" : "normal", children }];
}

type Message = GameState["message"];
type Lines = ReturnType<typeof expandText>;

/** 見出しの行（あれば）と選択肢の窓を置く高さ・縦位置。 */
function placeWindow(msg: Message, rows: number, screen: SystemSettings["screen"]): { x: number; y: number; w: number; h: number } {
  const w = screen.width - MESSAGE_MARGIN * 2;
  const h = Math.min(rows * UI_ROW_HEIGHT + MESSAGE_PADDING * 2, screen.height - MESSAGE_MARGIN * 2);
  const y = msg.position === "top" ? MESSAGE_MARGIN : msg.position === "middle" ? Math.round((screen.height - h) / 2) : screen.height - MESSAGE_MARGIN - h;
  return { x: MESSAGE_MARGIN, y, w, h };
}

const plain = (line: Lines[number]): string => line.map((r) => r.text).join("");

/** 選択肢の窓：見出し（`text`）の行の下に選択肢を縦に並べ、カーソルを重ねる。多いときはカーソルが見える範囲だけ出す。 */
function projectChoices(msg: Message, header: Lines, screen: SystemSettings["screen"]): UiNode[] {
  const choices = msg.choices ?? [];
  const head = header.filter((l) => l.length > 0).map(plain);
  const maxRows = Math.floor((screen.height - MESSAGE_MARGIN * 2 - MESSAGE_PADDING * 2) / UI_ROW_HEIGHT);
  const visible = Math.max(1, Math.min(choices.length, maxRows - head.length));
  const box = placeWindow(msg, head.length + visible, screen);
  const first = firstVisible(msg.cursor ?? 0, choices.length, visible);
  const children: UiNode[] = head.map((line, i) => textNode(box.x + MESSAGE_PADDING, box.y + MESSAGE_PADDING + i * UI_ROW_HEIGHT + 2, line));
  choices.slice(first, first + visible).forEach((choice, i) => {
    children.push(textNode(box.x + MESSAGE_PADDING + 8, box.y + MESSAGE_PADDING + (head.length + i) * UI_ROW_HEIGHT + 2, choice));
  });
  const row = (msg.cursor ?? 0) - first;
  if (row >= 0 && row < visible) children.push(cursorNode(box.x + 4, box.y + MESSAGE_PADDING + (head.length + row) * UI_ROW_HEIGHT, box.w - 8));
  return [windowNode(box.x, box.y, box.w, box.h, children)];
}

const DIGIT_WIDTH = 16;

/** 数値入力の窓：桁ごとに数字を並べ、編集中の桁にカーソルを置く。 */
function projectNumberInput(msg: Message, header: Lines, screen: SystemSettings["screen"]): UiNode[] {
  const input = msg.numberInput!;
  const head = header.filter((l) => l.length > 0).map(plain);
  const digits = String(input.value).padStart(input.digits, "0");
  const box = placeWindow(msg, head.length + 1, screen);
  const w = Math.min(box.w, input.digits * DIGIT_WIDTH + MESSAGE_PADDING * 2 + 8);
  const x = Math.round((screen.width - w) / 2);
  const children: UiNode[] = head.map((line, i) => textNode(x + MESSAGE_PADDING, box.y + MESSAGE_PADDING + i * UI_ROW_HEIGHT + 2, line));
  const rowY = box.y + MESSAGE_PADDING + head.length * UI_ROW_HEIGHT;
  [...digits].forEach((d, i) => children.push(textNode(x + MESSAGE_PADDING + 4 + i * DIGIT_WIDTH + 3, rowY + 2, d)));
  children.push({ kind: "cursor", x: x + MESSAGE_PADDING + 4 + (msg.cursor ?? 0) * DIGIT_WIDTH, y: rowY, w: DIGIT_WIDTH, h: UI_ROW_HEIGHT, blink: false });
  return [windowNode(x, box.y, w, box.h, children)];
}
