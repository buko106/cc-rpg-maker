import type { Config } from "./config.js";
import { cellOf, DIRS, distances, inRoom, STAIRS, TREASURE, walkable } from "./generate.js";
import type { Pt } from "./generate.js";
import { LOG_LINES, MAX_POPUPS } from "./model.js";
import type { DungeonState, EnemyState, Popup } from "./model.js";

/** 主人公の、変わっていく部分（`GameState.actors` の値から読み書きする）。 */
export interface Hero {
  level: number;
  exp: number;
  hp: number;
}
export interface HeroStats {
  mhp: number;
  atk: number;
  def: number;
}
export interface EnemyDef {
  name: string;
  mhp: number;
  atk: number;
  def: number;
  exp: number;
  gold: number;
  drops: readonly { item: string; rate: number }[];
}

/** ターンの計算に必要な、データベースと乱数への窓口。 */
export interface Env {
  readonly cfg: Config;
  readonly heroName: string;
  /** レベルごとの能力（`atkBonus` を足す前）。 */
  heroStats(level: number): HeroStats;
  enemy(id: string): EnemyDef | undefined;
  itemName(id: string): string;
  readonly rng: { next(): number; int(lo: number, hi: number): number };
}

/**
 * 1 回のコマンドの間だけ使う、書き換えてよい作業用の状態。`ds` は `cloneDungeon` した複製で、終わったら状態に書き戻す。
 */
export interface Work {
  ds: DungeonState;
  hero: Hero;
  gold: number;
  items: Record<string, number>;
  tick: number;
  outcome?: "stairs" | "treasure" | "dead";
}

export const MAX_LEVEL = 30;
/** レベル `level` から次のレベルに上がるのに必要な、合計の経験値。 */
export const expNeeded = (level: number): number => (15 * level * (level + 1)) / 2;
/** ポップアップを出しておく長さ（フレーム）。 */
export const POPUP_FRAMES = 50;

const key = (ds: DungeonState, x: number, y: number): number => y * ds.width + x;

export function say(w: Work, msg: string): void {
  w.ds.log.push(msg);
  if (w.ds.log.length > LOG_LINES) w.ds.log.splice(0, w.ds.log.length - LOG_LINES);
}

export function pop(w: Work, x: number, y: number, text: string, tone: Popup["tone"]): void {
  w.ds.fx = w.ds.fx.filter((f) => w.tick - f.t < POPUP_FRAMES);
  w.ds.fx.push({ x, y, text, tone, t: w.tick });
  if (w.ds.fx.length > MAX_POPUPS) w.ds.fx.splice(0, w.ds.fx.length - MAX_POPUPS);
}

/** 主人公の最大 HP・攻撃力・防御力を、今のレベルと種の分に合わせる（HP は最大を超えない）。 */
export function refreshStats(w: Work, env: Env): void {
  const s = env.heroStats(w.hero.level);
  w.ds.mhp = s.mhp;
  w.ds.atk = s.atk + w.ds.atkBonus;
  w.ds.def = s.def;
  w.hero.hp = Math.min(w.hero.hp, s.mhp);
}

export const enemyAt = (ds: DungeonState, x: number, y: number): EnemyState | undefined => ds.enemies.find((e) => e.x === x && e.y === y);
const itemAt = (ds: DungeonState, x: number, y: number) => ds.items.find((i) => i.x === x && i.y === y);
const roomOf = (ds: DungeonState, x: number, y: number) => ds.rooms.find(([rx, ry, rw, rh]) => inRoom({ x: rx, y: ry, w: rw, h: rh }, x, y));

/** (x, y) がプレイヤーから見えるか。部屋の中なら部屋全体（と、その壁）、通路なら近く（歩いて数歩）だけ。 */
export function canSee(ds: DungeonState, x: number, y: number): boolean {
  const room = roomOf(ds, ds.px, ds.py);
  if (room !== undefined) {
    const [rx, ry, rw, rh] = room;
    if (x >= rx - 1 && x <= rx + rw && y >= ry - 1 && y <= ry + rh) return true;
  }
  return Math.abs(x - ds.px) + Math.abs(y - ds.py) <= 3;
}

/** いま見えている場所を、歩いて見た場所（`seen`）に加える。 */
export function reveal(ds: DungeonState): void {
  const room = roomOf(ds, ds.px, ds.py);
  const seen = ds.seen.split("");
  const mark = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < ds.width && y < ds.height) seen[key(ds, x, y)] = "1";
  };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mark(ds.px + dx, ds.py + dy);
  if (room !== undefined) {
    const [rx, ry, rw, rh] = room;
    for (let y = ry - 1; y <= ry + rh; y++) for (let x = rx - 1; x <= rx + rw; x++) mark(x, y);
  }
  ds.seen = seen.join("");
}

/** ダメージの計算：攻撃力 − 防御力の半分 ± 1（最低 1）。 */
export const damage = (atk: number, def: number, rng: Env["rng"]): number => Math.max(1, atk - Math.floor(def / 2) + rng.int(-1, 1));

function levelUp(w: Work, env: Env): void {
  while (w.hero.level < MAX_LEVEL && w.hero.exp >= expNeeded(w.hero.level)) {
    const before = env.heroStats(w.hero.level).mhp;
    w.hero.level += 1;
    const after = env.heroStats(w.hero.level).mhp;
    w.hero.hp += after - before;
    refreshStats(w, env);
    say(w, `${env.heroName}は レベル${w.hero.level}に あがった！`);
    pop(w, w.ds.px, w.ds.py, "LEVEL UP!", "info");
  }
}

/** 敵 `e` をプレイヤーが攻撃する。倒したら、経験値・お金・ドロップ（その場に落ちる）を得る。 */
export function attackEnemy(w: Work, env: Env, e: EnemyState): void {
  const def = env.enemy(e.kind);
  const name = def?.name ?? e.kind;
  const dmg = damage(w.ds.atk, def?.def ?? 0, env.rng);
  e.hp -= dmg;
  pop(w, e.x, e.y, String(dmg), "dmg");
  say(w, `${env.heroName}の こうげき！ ${name}に ${dmg}ダメージ`);
  if (e.hp > 0) return;
  w.ds.enemies = w.ds.enemies.filter((x) => x !== e);
  w.ds.kills += 1;
  say(w, `${name}を たおした！ 経験値 ${def?.exp ?? 0}`);
  w.hero.exp += def?.exp ?? 0;
  w.gold += def?.gold ?? 0;
  for (const d of def?.drops ?? []) {
    if (env.rng.next() < d.rate && itemAt(w.ds, e.x, e.y) === undefined) w.ds.items.push({ key: `drop:${d.item}`, x: e.x, y: e.y, amt: 0 });
  }
  levelUp(w, env);
}

/** プレイヤーが (x, y) に着いた：落ちている物を拾い、階段や宝なら結果を決める。 */
export function arriveAt(w: Work, env: Env, x: number, y: number): void {
  const ds = w.ds;
  ds.px = x;
  ds.py = y;
  reveal(ds);
  const item = itemAt(ds, x, y);
  if (item !== undefined) {
    ds.items = ds.items.filter((i) => i !== item);
    if (item.key.startsWith("drop:")) {
      const id = item.key.slice(5);
      w.items[id] = (w.items[id] ?? 0) + 1;
      say(w, `${env.itemName(id)}を ひろった`);
    } else {
      const entry = env.cfg.items.find((i) => i.key === item.key);
      if (entry?.kind === "item") {
        w.items[entry.item] = (w.items[entry.item] ?? 0) + 1;
        say(w, `${env.itemName(entry.item)}を ひろった`);
      } else if (entry?.kind === "food") {
        ds.belly = Math.min(env.cfg.belly.max, ds.belly + entry.amount);
        say(w, `${entry.name}を 食べた！ おなかが ふくれた`);
        pop(w, x, y, `+${entry.amount}`, "heal");
      } else if (entry?.kind === "gold") {
        w.gold += item.amt;
        say(w, `${item.amt}ゴールドを ひろった`);
      } else if (entry?.kind === "seed") {
        ds.atkBonus += entry.atk;
        refreshStats(w, env);
        say(w, `${entry.name}を 食べた！ こうげき力が ${entry.atk} あがった`);
        pop(w, x, y, `ATK+${entry.atk}`, "info");
      }
    }
  }
  const tile = ds.grid[key(ds, x, y)];
  if (tile === STAIRS) w.outcome = "stairs";
  else if (tile === TREASURE) w.outcome = "treasure";
}

/** 敵のターン：近くにいれば追いかけて、隣にいれば攻撃する。気づいていなければうろうろする。 */
function enemyPhase(w: Work, env: Env): void {
  const ds = w.ds;
  const dm = distances(ds.grid, ds.width, ds.height, { x: ds.px, y: ds.py });
  const occupied = (x: number, y: number, self: EnemyState): boolean => (x === ds.px && y === ds.py) || ds.enemies.some((o) => o !== self && o.x === x && o.y === y);
  for (const e of [...ds.enemies].sort((a, b) => a.id - b.id)) {
    const def = env.enemy(e.kind);
    if (def === undefined) continue;
    const act = env.cfg.enemies.find((x) => x.enemy === e.kind)?.act ?? "normal";
    const actions = act === "fast" ? 2 : act === "slow" ? (ds.turn % 2 === 0 ? 1 : 0) : 1;
    for (let i = 0; i < actions; i++) {
      const d = dm.get(cellOf(ds.width, e));
      if (d === 1) {
        const dmg = damage(def.atk, ds.def, env.rng);
        w.hero.hp -= dmg;
        pop(w, ds.px, ds.py, String(dmg), "hurt");
        say(w, `${def.name}の こうげき！ ${dmg}ダメージを うけた`);
        if (w.hero.hp <= 0) {
          say(w, `${env.heroName}は ちからつきた……`);
          w.outcome = "dead";
          return;
        }
        continue;
      }
      let to: Pt | undefined;
      if (d !== undefined && d <= env.cfg.sight) {
        to = DIRS.map((v) => ({ x: e.x + v.x, y: e.y + v.y })).find((p) => dm.get(cellOf(ds.width, p)) === d - 1 && !occupied(p.x, p.y, e));
      } else if (env.rng.next() < 0.6) {
        const v = DIRS[env.rng.int(0, DIRS.length - 1)] as Pt;
        const p = { x: e.x + v.x, y: e.y + v.y };
        if (walkable(ds.grid[cellOf(ds.width, p)]) && !occupied(p.x, p.y, e)) to = p;
      }
      if (to === undefined) continue;
      if (e.t !== w.tick) {
        e.fx = e.x;
        e.fy = e.y;
      }
      e.x = to.x;
      e.y = to.y;
      e.t = w.tick;
    }
  }
}

/**
 * 1 ターンの終わり：敵が動き、満腹度が減り、HP が回復する（満腹度が 0 のあいだは減る）。倒れたら `outcome` が `dead` になる。
 */
export function endTurn(w: Work, env: Env): void {
  const ds = w.ds;
  ds.turn += 1;
  enemyPhase(w, env);
  if (w.outcome === "dead") return;
  const { belly, regenInterval } = env.cfg;
  if (ds.belly > 0 && ds.turn % belly.interval === 0) {
    ds.belly -= 1;
    if (ds.belly === belly.hungry) say(w, "おなかが すいてきた……");
    else if (ds.belly === belly.weak) say(w, "ふらふらしてきた……");
    else if (ds.belly === 0) say(w, "おなかが ぺこぺこで 力が 出ない！");
  }
  if (ds.belly === 0) {
    w.hero.hp -= belly.starveDamage;
    pop(w, ds.px, ds.py, String(belly.starveDamage), "hurt");
    if (w.hero.hp <= 0) {
      say(w, `${env.heroName}は 空腹で たおれた……`);
      w.outcome = "dead";
    }
  } else if (w.hero.hp < ds.mhp && ds.turn % regenInterval === 0) {
    w.hero.hp += 1;
  }
}
