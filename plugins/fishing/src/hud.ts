import { ui as u } from "@rpg/plugin-api";
import type { FrameSpec, GameState, RGBA, UiNode } from "@rpg/plugin-api";
import type { Config, FishEntry } from "./config.js";
import { BITE_FRAMES } from "./fish.js";
import { readFishing } from "./model.js";
import type { CastState, FishingState } from "./model.js";

type Color = RGBA;

const WHITE: Color = { r: 255, g: 255, b: 255, a: 1 };
const GRAY: Color = { r: 200, g: 200, b: 210, a: 1 };
const YELLOW: Color = { r: 255, g: 235, b: 130, a: 1 };
const RED: Color = { r: 255, g: 110, b: 110, a: 1 };
const GREEN: Color = { r: 140, g: 255, b: 160, a: 1 };
const { text, rect, gauge, panel } = u;

/** 巻き上げのバーの長さ（ピクセル）。 */
export const BAR_W = 300;
const VEC = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const;

const cm = (n: number): string => `${n.toFixed(1)}cm`;
const fishName = (cfg: Config, key: string | null): string => cfg.fish.find((f) => f.key === key)?.name ?? "？？？";

/** 釣りの表示（大会の点数・ウキ・巻き上げのバー・結果・図鑑・結果発表）を、マップの FrameSpec に足す。 */
export function fishingHud(frame: FrameSpec, state: GameState, cfg: Config | undefined): FrameSpec {
  const fs = readFishing(state);
  if (fs === undefined || cfg === undefined) return frame;
  const tiles = frame.layers.find((l) => l.kind === "tiles");
  const ts = tiles !== undefined && tiles.kind === "tiles" ? tiles.tileSize : 32;
  const ui: UiNode[] = [];
  if (fs.tournament !== null) ui.push(...tournamentHud(fs.tournament));
  if (fs.cast !== null) ui.push(...castHud(fs.cast, state, frame, ts, cfg));
  if (fs.screen?.kind === "album") ui.push(...albumScreen(fs, frame, cfg));
  if (fs.screen?.kind === "result") ui.push(...resultScreen(fs.screen, frame, cfg));
  return ui.length === 0 ? frame : { ...frame, ui: [...frame.ui, ...ui] };
}

function tournamentHud(t: NonNullable<FishingState["tournament"]>): UiNode[] {
  return [panel(8, 8, 150, 46, [text(16, 12, "釣り大会", YELLOW, 13, "left", true), text(150, 12, `${t.score} てん`, WHITE, 14, "right", true), text(16, 31, `つれた魚 ${t.catches} ひき`, GRAY, 12)])];
}

function castHud(c: CastState, state: GameState, frame: FrameSpec, ts: number, cfg: Config): UiNode[] {
  const W = frame.size.width;
  const H = frame.size.height;
  const p = state.map.player;
  const [dx, dy] = VEC[p.direction];
  const sx = p.realX * ts - frame.camera.x + ts / 2;
  const sy = p.realY * ts - frame.camera.y + ts / 2;
  const ui: UiNode[] = [];

  if (c.phase !== "done") {
    // ウキ：竿の先、2 マス向こうに浮かぶ。あたりが来ると沈んで揺れる
    const bite = c.phase === "bite" || c.phase === "reel";
    const bob = bite ? Math.round(Math.sin(c.t / 2) * 3) + 3 : Math.round(Math.sin(c.t / 14) * 1.5);
    const bx = sx + dx * 2 * ts;
    const by = sy + dy * 2 * ts + bob;
    if (!bite && Math.floor(c.t / 24) % 2 === 0) ui.push(rect(bx - 9, by + 7, 18, 1, { ...WHITE, a: 0.6 }), rect(bx - 5, by + 10, 10, 1, { ...WHITE, a: 0.4 }));
    if (bite) ui.push(rect(bx - 10, by + 6, 20, 1, { ...WHITE, a: 0.8 }), rect(bx - 6, by + 9, 12, 1, { ...WHITE, a: 0.6 }));
    ui.push(rect(bx - 3, by - 5, 6, 4, { r: 235, g: 70, b: 70, a: 1 }), rect(bx - 3, by - 1, 6, 4, WHITE));
  }

  if (c.phase === "wait") {
    const dots = ".".repeat(1 + (Math.floor(c.t / 20) % 3));
    ui.push(panel(W / 2 - 110, H - 62, 220, 46, [text(W / 2, H - 56, `じっと まつ ${dots}`, WHITE, 15, "center", true), text(W / 2, H - 36, `エサ：${c.bait ?? "なし"}　（キャンセルで やめる）`, GRAY, 11, "center")], "dim"));
  } else if (c.phase === "bite") {
    ui.push(text(sx, sy - ts - 6 - Math.round(Math.abs(Math.sin(c.t / 3)) * 4), "！", RED, 34, "center", true));
    ui.push(panel(W / 2 - 110, H - 62, 220, 46, [text(W / 2, H - 56, "あたりだ！ 決定ボタン！", YELLOW, 15, "center", true), gauge(W / 2 - 90, H - 32, 180, 6, c.left / BITE_FRAMES, RED)], "dim"));
  } else if (c.phase === "reel") {
    const x = (W - BAR_W) / 2;
    const y = H - 98;
    const half = c.zoneSize / 2;
    const inside = Math.abs(c.pos - c.zone) <= half;
    ui.push(
      panel(x - 20, y - 8, BAR_W + 40, 86, [
        text(x, y - 3, "まきあげろ！", WHITE, 14, "left", true),
        text(x + BAR_W, y - 1, "押している間 → ／ はなすと ←", GRAY, 11, "right"),
        rect(x, y + 20, BAR_W, 16, { r: 28, g: 38, b: 62, a: 1 }),
        rect(x + (c.zone - half) * BAR_W, y + 20, c.zoneSize * BAR_W, 16, { r: 70, g: 190, b: 120, a: 1 }),
        rect(x + c.pos * BAR_W - 5, y + 18, 10, 20, inside ? { r: 255, g: 215, b: 80, a: 1 } : { r: 255, g: 120, b: 90, a: 1 }),
        gauge(x, y + 48, BAR_W, 8, c.progress, inside ? { r: 110, g: 220, b: 130, a: 1 } : { r: 240, g: 190, b: 90, a: 1 }),
      ]),
    );
  } else if (c.result !== null) {
    const r = c.result;
    const lines: [string, Color, number][] = [];
    switch (r.kind) {
      case "caught":
        lines.push([`${fishName(cfg, r.fish)}  ${cm(r.size)}`, WHITE, 20], ["つりあげた！", YELLOW, 14]);
        if (r.first) lines.push(["はじめて つった 魚だ！（つり手帳に のった）", GREEN, 12]);
        else if (r.record) lines.push(["自己ベスト！", GREEN, 12]);
        if (r.points > 0) lines.push([`＋${r.points} てん`, YELLOW, 14]);
        break;
      case "lost":
        lines.push(["あっ！ にげられた……", RED, 18], [`${fishName(cfg, r.fish)} だったのに……`, GRAY, 12]);
        break;
      case "missed":
        lines.push(["あたりを のがした……", RED, 18]);
        break;
      case "early":
        lines.push(["はやく あげすぎた！", RED, 18], ["あたりが きてから 決定ボタン", GRAY, 12]);
        break;
      case "nothing":
        lines.push(["なにも かからなかった", GRAY, 16]);
        break;
      case "quit":
        break;
    }
    const h = 20 + lines.reduce((n, l) => n + l[2] + 8, 0);
    const y = 64; // プレイヤーとウキが隠れないよう、画面の上寄りに出す
    let yy = y + 12;
    const nodes: UiNode[] = [];
    for (const [t, color, size] of lines) {
      nodes.push(text(W / 2, yy, t, color, size, "center", size >= 18));
      yy += size + 8;
    }
    ui.push(panel(W / 2 - 150, y, 300, h, nodes));
  }
  return ui;
}

/** 図鑑に並べる魚。 */
const albumRows = (fs: FishingState, cfg: Config): { fish: FishEntry; entry: FishingState["album"][string] | undefined }[] => cfg.fish.map((fish) => ({ fish, entry: fs.album[fish.key] }));

function albumScreen(fs: FishingState, frame: FrameSpec, cfg: Config): UiNode[] {
  const W = frame.size.width;
  const H = frame.size.height;
  const rows = albumRows(fs, cfg);
  const known = rows.filter((r) => r.entry !== undefined).length;
  const rowH = Math.min(24, Math.floor((H - 130) / Math.max(1, rows.length)));
  const x = 48;
  const w = W - 96;
  const children: UiNode[] = [text(x + 14, 36, "つり手帳", YELLOW, 18, "left", true), text(x + w - 14, 40, `${known} / ${rows.length} しゅるい`, WHITE, 14, "right", true)];
  rows.forEach(({ fish, entry }, i) => {
    const y = 72 + i * rowH;
    children.push(text(x + 16, y, `${String(i + 1).padStart(2, "0")}`, GRAY, 13));
    if (entry === undefined) children.push(text(x + 48, y, "？？？？？", GRAY, 14));
    else children.push(text(x + 48, y, fish.name, WHITE, 14, "left", true), text(x + w - 150, y, `さいだい ${cm(entry.best)}`, YELLOW, 13, "right"), text(x + w - 16, y, `${entry.count} ひき`, WHITE, 13, "right"));
  });
  children.push(text(W / 2, H - 52, known === rows.length ? "ぜんぶの 魚を つりあげた！" : "決定ボタンで とじる", known === rows.length ? GREEN : GRAY, 12, "center"));
  return [panel(x, 24, w, H - 48, children)];
}

function resultScreen(r: Extract<NonNullable<FishingState["screen"]>, { kind: "result" }>, frame: FrameSpec, cfg: Config): UiNode[] {
  const W = frame.size.width;
  const H = frame.size.height;
  const rowH = 26;
  const h = 150 + r.ranking.length * rowH;
  const y = Math.max(16, (H - h) / 2);
  const x = 60;
  const w = W - 120;
  const children: UiNode[] = [text(W / 2, y + 12, "けっか はっぴょう", YELLOW, 20, "center", true)];
  r.ranking.forEach((s, i) => {
    const yy = y + 50 + i * rowH;
    const color = s.you ? YELLOW : WHITE;
    children.push(text(x + 24, yy, `${i + 1}位`, color, 15, "left", true), text(x + 80, yy, s.name, color, 15, "left", s.you), text(x + w - 24, yy, `${s.score} てん`, color, 15, "right", s.you));
  });
  const by = y + 58 + r.ranking.length * rowH;
  const prize = cfg.tournament.prizes[r.rank - 1] ?? 0;
  children.push(text(W / 2, by, r.rank === 1 ? "ゆうしょう！ おめでとう！" : `${r.rank}位だった`, r.rank === 1 ? GREEN : WHITE, 16, "center", true));
  children.push(text(W / 2, by + 24, prize > 0 ? `賞金 ${prize}G${r.trophy ? "　＋　トロフィー" : ""}` : "賞金は ない", prize > 0 ? YELLOW : GRAY, 14, "center"));
  children.push(text(W / 2, by + 48, "決定ボタンで とじる", GRAY, 11, "center"));
  return [panel(x, y, w, h, children)];
}
