#!/usr/bin/env node
/**
 * 遊べるデモの一覧ページと、デモごとのプレイヤーをビルドする。
 *
 *   node tools/build-demos.mjs [--out <dir>]
 *
 * 出力（既定は apps/player/dist-demos/。サイトでは site-dist/demo/ に置く）:
 *   index.html        デモを選ぶページ（DEMOS から作る）
 *   img/<slug>.png    一覧に出す画面写真（site/img/ から）
 *   <slug>/           demo プロジェクト付きのプレイヤー（apps/player/scripts/build-web.mjs。フォルダ形式の配布物と同じ形）
 * どのページも相対パスだけで参照し合うので、サブパスでも動く。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = resolve(import.meta.dirname, "..");

/** 遊べるデモ。上から順に一覧に並ぶ。 */
export const DEMOS = [
  {
    slug: "village",
    project: "fixtures/projects/v1/demo",
    title: "はじまりの村",
    image: "site/img/demo.png",
    description: "村を歩いて、話しかけて、スライムと戦う。商人の店や、村人の家もあります。ネコとヒヨコも歩いています。",
    tags: ["会話", "戦闘", "ショップ", "セーブ"],
  },
  {
    slug: "maze",
    project: "fixtures/projects/v1/maze",
    title: "地下迷宮",
    image: "site/img/maze.png",
    description: "上下左右に出入口がある 20 の洞窟の間を抜けて、出口の光を目指す。道を間違えると同じ間をさまよったり、入口の方へ押し戻されたりします。ときどき立っている看板が手がかり。",
    tags: ["迷路", "20 の部屋", "看板"],
  },
  {
    slug: "tower",
    project: "fixtures/projects/v1/tower",
    title: "バトルタワー",
    image: "site/img/tower.png",
    description: "各階の番人を倒して塔の屋上を目指す。ゴブリン、毒の大グモ、固いゴーレム、眠りの魔術師、そして炎の竜。途中で僧侶が仲間に。負けても入口から何度でも挑めます。記録できるのは泉だけ。",
    tags: ["戦闘", "ボス", "仲間", "スキル"],
  },
  {
    slug: "mansion",
    project: "fixtures/projects/v1/mansion",
    title: "謎解きの館",
    image: "site/img/mansion.png",
    description: "閉じこめられた古い館から脱出する。甲冑のなぞなぞ、順番どおりに灯すろうそく、4 けたの金庫、鍵選び。手がかりは館のあちこちに。困ったらネコに聞いてみて。",
    tags: ["謎解き", "脱出", "戦闘なし"],
  },
  {
    slug: "haunted",
    project: "fixtures/projects/v1/haunted",
    title: "おばけ屋敷の追いかけっこ",
    image: "site/img/haunted.png",
    description: "暗いお屋敷を歩き回るおばけを避けながら、3 つの階のろうそくを全部集める。おばけに捕まると入口へ戻されます。近づいてくるもの、見回るもの、壁を抜けてくるもの、近づいては逃げるもの。",
    tags: ["追いかけっこ", "自律移動", "戦闘なし"],
  },
  {
    slug: "stealth",
    project: "fixtures/projects/v1/stealth",
    title: "忍び込み！月影の宝物庫",
    image: "site/img/stealth.png",
    description: "夜の屋敷に忍び込み、宝物庫の宝を 3 つ盗んで門から逃げる。見張りの視界は向いている方向だけ。柱や木箱のかげ、背後に回りこめば見つからない。見つかると警報が鳴り、見張りが道を探して追ってきます。",
    tags: ["ステルス", "視界", "戦闘なし"],
  },
  {
    slug: "hokora",
    project: "fixtures/projects/v1/hokora",
    title: "ほこらの冒険",
    image: "site/img/hokora.png",
    description: "村で支度をして、草原と洞窟を抜け、ほこらの主を倒す王道の一本道。歩くたびに魔物に出会うランダムエンカウント。メニューのアイテムやヒールで回復しながら進みます。宿屋で休んで記録も。",
    tags: ["ランダムエンカウント", "戦闘", "ショップ", "セーブ"],
  },
  {
    slug: "ice",
    project: "fixtures/projects/v1/ice",
    title: "氷の神殿",
    image: "site/img/ice.png",
    description: "凍った神殿の奥から「炎のしずく」を持ち帰る。氷の床は止まるまで滑り、岩は押して動かせます。岩を感圧板にのせると扉が開く、頭を使う空間パズル。詰んでも入口の魔法陣でやり直せます。",
    tags: ["滑る床", "押せる岩", "パズル", "戦闘なし"],
  },
];

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** デモを選ぶページの HTML。 */
export function chooserHtml(demos = DEMOS) {
  const cards = demos
    .map(
      (d) => `        <li>
          <a class="card" href="${d.slug}/">
            <img src="img/${d.slug}.png" alt="${escape(d.title)}の画面" loading="lazy" />
            <span class="body">
              <strong>${escape(d.title)}</strong>
              <span class="desc">${escape(d.description)}</span>
              <span class="tags">${d.tags.map((t) => `<span>${escape(t)}</span>`).join("")}</span>
            </span>
          </a>
        </li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>デモを選ぶ — cc-rpg-maker</title>
    <meta name="description" content="cc-rpg-maker で作ったサンプルゲーム。遊びたいデモを選んでください。" />
    <meta name="theme-color" content="#1b2340" />
    <style>
      :root { --bg: #12151f; --surface: #1b2030; --ink: #e9e7df; --muted: #a4a9bd; --line: #2c3247; --accent: #ffd166; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.7 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif; }
      .wrap { max-width: 960px; margin: 0 auto; padding: 40px 16px 56px; }
      h1 { margin: 0 0 4px; font-size: clamp(1.6rem, 5vw, 2.2rem); line-height: 1.3; }
      .lead { margin: 0 0 28px; color: var(--muted); }
      ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin: 0; padding: 0; list-style: none; }
      .card { display: flex; flex-direction: column; height: 100%; color: inherit; text-decoration: none; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; transition: transform 0.12s, border-color 0.12s; }
      .card:hover, .card:focus-visible { transform: translateY(-2px); border-color: var(--accent); outline: none; }
      .card img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; image-rendering: pixelated; background: #000; }
      .body { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px 16px; flex: 1; }
      strong { font-size: 1.2rem; color: var(--accent); }
      .desc { color: var(--muted); font-size: 0.95rem; line-height: 1.6; }
      .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; padding-top: 6px; }
      .tags span { font-size: 0.8rem; padding: 1px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); }
      .keys { margin: 32px 0 0; color: var(--muted); font-size: 0.9rem; }
      .back { display: inline-block; margin-bottom: 20px; color: var(--muted); }
    </style>
  </head>
  <body>
    <main class="wrap">
      <a class="back" href="../">← cc-rpg-maker</a>
      <h1>デモを選ぶ</h1>
      <p class="lead">cc-rpg-maker で作ったサンプルゲームです。遊びたいものを選んでください。</p>
      <ul>
${cards}
      </ul>
      <p class="keys">移動：矢印キー / WASD　決定：Enter / Z / Space　キャンセル：Esc / X　メニュー：M（スマホでは画面の操作パッド）</p>
    </main>
  </body>
</html>
`;
}

export async function buildDemos({ out, quiet = false }) {
  const dir = resolve(out);
  const stdio = quiet ? "ignore" : "inherit";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "img"), { recursive: true });
  for (const demo of DEMOS) {
    execFileSync(process.execPath, [join(repo, "apps/player/scripts/build-web.mjs"), "--project", demo.project, "--out", join(dir, demo.slug)], { stdio, cwd: repo });
    cpSync(join(repo, demo.image), join(dir, "img", `${demo.slug}.png`));
  }
  writeFileSync(join(dir, "index.html"), chooserHtml());
  if (!quiet) console.log(`デモ（${DEMOS.map((d) => d.slug).join(", ")}）を ${dir} にビルドした`);
}

// CLI として起動されたときだけビルドする（テストからは buildDemos を import する）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  await buildDemos({ out: values.out ?? join(repo, "apps/player/dist-demos") });
}
