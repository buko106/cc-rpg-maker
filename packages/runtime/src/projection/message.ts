import type { GameState } from "@rpg/core";
import type { SystemSettings } from "@rpg/schema";
import type { UiNode } from "../frame-spec.js";
import { expandText } from "../text-codec.js";
import { FACE_SIZE, MESSAGE_FONT, MESSAGE_LINE_HEIGHT, MESSAGE_LINES, MESSAGE_MARGIN, MESSAGE_PADDING, textColor } from "./theme.js";

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
