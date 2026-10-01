# 15. `@rpg/player`（apps/player） — 配布用シェルとエクスポータ

## 責務
- プレイヤー向けの最小 HTML シェル。`runtime` に本番アダプタを結線して起動する。
- エクスポータ：エディタのプロジェクトから配布物を生成する。
  - **フォルダ形式**：`index.html` + `player.js` + `project/`（JSON）+ `assets/`。静的ホスティング用。
  - **単一 HTML 形式**：すべてを base64 埋め込み（`createEmbeddedBytesSource`）。メール等で配れる。
- ローディング画面、エラー画面、音声解禁のためのタップ待ち画面。
- オプション：Service Worker によるオフライン化（フォルダ形式のみ）。

## 非責務
- ゲームの実行ロジック。→ `runtime`
- プロジェクトの保存。→ `project-store`（`exportZip` を利用）

## 依存が許されるパッケージ
`@rpg/runtime`, `@rpg/plugin-api`, `@rpg/schema`, 任意のアダプタ。エクスポータは `@rpg/project-store`（ポート型）。

## 公開インターフェース
```ts
// シェル
export interface PlayerConfig {
  projectUrl?: string;                           // フォルダ形式：project/project.json
  embedded?: { project: unknown; maps: Record<MapId, unknown>; assets: Record<AssetId, string> };
  renderer?: "canvas2d" | "webgl" | "auto";
  plugins?: PluginModule[];
  saveScope?: string;                            // 同一オリジンで複数ゲームを配るときの分離キー
}
export async function bootPlayer(root: HTMLElement, config: PlayerConfig): Promise<Runtime>;

// エクスポータ（エディタ内で実行）
export interface ExportOptions { format: "folder" | "singleHtml"; renderer: PlayerConfig["renderer"]; offline?: boolean; minifyJson?: boolean }
export async function exportGame(repo: ProjectRepository, projectId: string, opts: ExportOptions): Promise<Blob>;   // ZIP または HTML
```

## 実装指針
- `bootPlayer` の結線：
  - `renderer: "auto"` は WebGL 対応かつ `render-webgl` がバンドルされていれば webgl、それ以外 canvas2d。
  - `saves: createSaveRepository({ projectId, projectHash, ... })`。`projectHash` は `project.json` のハッシュ。
  - `input: createBrowserInput(window, { touch: { canvas } })`。
  - `audio`: `AudioContext` は初回ユーザー操作で生成。
- ローディング：`assets.preload` にシステム・タイトル画面・開始マップのアセットを渡し進捗表示。
- エラー：`Runtime` の未捕捉例外はエラー画面へ。開発ビルドではスタックを表示。
- 単一 HTML：16 MB を超える場合は警告し、フォルダ形式を推奨する。
- ハッシュ付きファイル名でキャッシュ制御（`assets/<id>.<ext>` は不変なので `Cache-Control: immutable` 推奨、README に記載）。

## 不変条件
1. エクスポートした配布物は `apps/editor-ui` で動いたテストプレイと同じリプレイ結果を生む（プロジェクトハッシュが一致する）。
2. 単一 HTML 形式は外部リクエストを一切行わない。
3. `saveScope` が異なれば同一オリジンでもセーブが混ざらない。

## テスト要件
- エクスポータ：`fixtures/projects/v1/minimal` を両形式でエクスポートし、生成物の構造を検証（ZIP エントリ一覧、HTML 内の埋め込み JSON がパースできる）。
- Playwright：フォルダ形式を静的サーバで配信し、タイトル → 開始 → 歩行 → セーブ → リロード → ロード。単一 HTML を `file://` で開き同じシナリオ（ネットワークリクエスト 0 件を検証）。
- `renderer: "auto"` のフォールバック（WebGL を無効化した Playwright コンテキスト）。

## 完了条件
- 両形式のエクスポートが E2E を通る。
- ローディング/エラー/タップ待ち画面が実装されている。

## 実装メモ（M2 で確定した点）
- **実装範囲**：フォルダ形式の起動（`bootPlayer`）のみ。エクスポータ（`exportGame`）、単一 HTML、`renderer: "webgl" | "auto"`、`plugins`、`saveScope`、Service Worker、タップ待ち画面は後続。`PlayerConfig` は `{ projectUrl, assetsUrl?, debug? }`。
- **配布物の形**：`index.html` + `player.js` + `project/project.json` + `project/maps/<MapId>.json` + `assets/<AssetId>.<ext>`。アセットは `projectUrl` の隣の `../assets/`（`assetsUrl` で変更可）。
- **結線**：`createHttpProjectSource` → `createAssetSource(createHttpBytesSource)` → 開始前に `collectStartAssets`（タイルセット画像・アクターの歩行/顔・開始マップのイベントの絵）を `preload`（進捗表示）→ `createCanvas2dRenderer`（2 倍表示、`image-rendering: pixelated`）+ `createBrowserInput(window, { gamepad: true })` + `createNullAudioOut()`（音は M4）+ `createRafScheduler()`。`seed` は `Date.now()`。
- `createHttpProjectSource(projectUrl)`：`project.json` は一度だけ取得して検証し、`projectHash` はそのバイト列の sha256（hex）。マップはプロジェクトに登録された ID だけを `maps/<id>.json` から取得し、取得済みは覚えておく（失敗は覚えない）。
- **画面**：読み込み中（`role="status"`）と、失敗時のエラー画面（`role="alert"`、`debug` のときスタックも）。`Runtime` の `onError` もエラー画面へ。
- **ビルド**：`node apps/player/scripts/build-web.mjs [--project <dir>] [--out <dir>]` が esbuild で `player.js` を作り、`static/index.html` と（指定があれば）プロジェクトのフォルダをコピーする。出力の既定は `apps/player/dist-web/`（git 管理外）。`pnpm demo` でデモを配信（http://127.0.0.1:4173/）。エントリ（`main.ts`）は `?project=<url>` と `?debug` を受け、起動した Runtime を `window.__rpg` に置く（E2E とデバッグ用）。
- **M3 の変更**：`PlayerConfig` に `saveScope?`（同じオリジンで複数のゲームを配るとき、IndexedDB の DB 名 `rpg-saves-<scope>` と localStorage の接頭辞 `rpg-save-<scope>` に反映して保存先自体を分ける）を追加。`saves = createSaveRepository({ projectId: project.meta.id, projectHash })`（`projectHash` は `project.json` のバイト列の sha256）、`clock: Date.now` を Runtime に渡す。**タイトル画面から始まる**（`title` の既定が `true`）。キー操作は既定の割り当て（決定 = Z/Enter/Space、キャンセル = X/Esc、メニュー = M）。
- **E2E**（`e2e/player.spec.ts`）：Playwright の `webServer` が demo プロジェクト付きでビルドして `tools/serve-static.mjs` で配信する。起動と描画のピクセル確認、歩行と壁での停止、会話（ウィンドウと文字の描画、2 ページ目）、扉でのマップ遅延ロード（リクエストの発行タイミング）、読み込み失敗のエラー画面。

## 実装メモ（M4 で確定した点）
- **音**：`bootPlayer` は `audio-webaudio` を結線した（08）。`AssetSource` に `decodeAudio` を渡し、開始前の事前読み込み（`collectStartAssets`）に**敵の絵とタイトル/戦闘の BGM** を加えた（戦闘の初回に読み込みで止まらないように）。`AudioContext` が無い環境では音声は読み込まない。
- **demo プロジェクト**：マップ `map_town` の (11,8) にスライム（話しかけると戦闘。勝てば `sw_slime_defeated` を立てて消え、逃げれば残る）、戦闘 BGM（8bit の短いループ WAV）、スキル「ファイア」、アイテム「ポーション」（スライムが確実にドロップ）を追加。`map_town` の (2,5) には商人がいて、初めて話しかけると 100G をもらい、2 回目からショップ（ポーション・ハイポーション・エーテル。売却もできる）が開く。アセットは `node tools/make-demo-assets.mjs`（PNG と WAV。ID は内容のハッシュ）で生成する。
- **maze プロジェクト（地下迷宮）**：`fixtures/projects/v1/maze`。11×11 の正方形の部屋（上下左右の真ん中に出入口）が 20 あり、画面も 352×352 にして部屋全体を見せる。第 1〜19 の間は出入口のうち 1 つだけが次の間へ通じ、来た方向は 1 つ前の間へ戻る。残りは「ループ」（同じ間の反対側に出る）か「押し戻し」（メッセージのあと、第 8 の間までは第 1 の間へ、その先は 4 つ以上手前の看板の間へ）。第 1・5・9・13・17 の間の看板が、今が第何の間で出口まであといくつかを教える。5 つの間ごとに洞窟の色（土・石・水晶・深淵）が変わる。第 20 の間の光に触れるとクリアしてタイトルに戻る。部屋を移るときは `TransferPlayer` の `fade: "black"` で暗転する（暗転 → 場所移動 → 明転。終わるまで歩けない）。マップ・`project.json`・アセット（洞窟のタイルセット・看板）はすべて `node tools/make-maze-demo.mjs` が生成する（シード固定。ドット絵の小道具は `tools/pixel-art.mjs` を `make-demo-assets.mjs` と共有）。正解の道でクリアできること・間違いの出入口の行き先は `apps/player/src/maze-fixture.test.ts` が core の `step` で確かめる。
- **tower プロジェクト（バトルタワー）**：`fixtures/projects/v1/tower`。13×12 の階が 6 つ（1F エントランス・2F〜5F・屋上）で、画面も 416×384 にして階全体を見せる。1F には受付（説明と支度金・ポーション）、よろず屋（`ShopProcessing`）、回復の泉（回復して `SaveGame`。`system.menuSave: false` でメニューからはセーブできず、記録はこの泉＝セーブポータルでだけ）、訓練用のかかし（何度でも戦える）がある。2F〜屋上は番人が上り階段の前をふさぎ、話しかけて「挑む」と `BattleProcessing`（敗北可）：2F ゴブリン兄弟、3F 大グモ（毒）、4F ストーンゴーレム（守りが固く魔法向き）、5F 闇の魔術師と骸骨兵 2 体（眠り・全体魔法）、屋上 炎の竜（逃走不可。HP が半分を切ると業火）。勝つとセルフスイッチ A で番人が消え、負けると入口に戻されて HP/MP が戻る。3F の大グモを倒すと、捕らわれていた僧侶（ヒール・キュア・プロテクト・リザレク・ヒールオール）が `ChangeParty` で仲間に加わる。各階の下り階段のそばの魔法陣で回復できる。炎の竜を倒すとクリアしてタイトルに戻る。マップ・`project.json`・アセット（塔のタイルセット・人と魔物の歩行シート・敵の絵）はすべて `node tools/make-tower-demo.mjs` が生成する。`apps/player/src/tower-fixture.test.ts` が core の `step` で、素直な作戦（`test-utils` の `autoBattle`。メニューを十字キーと決定で操作する）で 1F から屋上まで登ってクリアできること、負けたときの戻り方、かかし、僧侶の加入を確かめる。敵の強さは、その作戦で各番人に 40 回挑ませた勝率（番人はほぼ必勝、炎の竜は 8 割ほど）を目安に決めた。
- **mansion プロジェクト（謎解きの館）**：`fixtures/projects/v1/mansion`。13×10 の部屋が 4 つ（玄関ホール・書斎・食堂・寝室）で、画面も 416×320。戦闘は無く、イベントだけで作った脱出ゲーム。はじめに自動実行のイベントで閉じこめられ、招待状（大事なもの）を受け取る。謎は順に：ホールの甲冑のなぞなぞ（`ShowChoices`。正解でスイッチが入り、甲冑のイベントが消えて、横の位置の甲冑のイベントが現れる）→ 書斎の家政婦のメモ（ろうそくの順番）→ 食堂の 4 本のろうそく（変数 `var_candle` が「何本目まで灯したか」。順番が合えば 1 増やし、違えば 0 に戻して全部消える。灯った絵は「変数が○以上」のページ）→ そろうと食器棚が開いて寝室の鍵 → 鍵を持っていると寝室の扉が通れる（アイテムのページ条件）→ 主の日記（金庫の番号は柱時計の時刻）→ 食堂の柱時計（10 時 47 分）→ 書斎の金庫（`InputNumber` で 4 けた。前に入れた番号から始まる）で玄関の鍵 → 玄関の扉で大事なものから選ぶ（`SelectItem`。ID の昇順での番号を変数に入れ、`ConditionalBranch` で比べる）と脱出してタイトルに戻る。ホールのネコは進み具合（変数 `var_stage`。戻らないように「○以下なら○にする」で進める）に応じたページで次の手がかりをくれる。マップ・`project.json`・アセット（館のタイルセット・ろうそく/甲冑/食器棚/金庫の絵）はすべて `node tools/make-mansion-demo.mjs` が生成する（ドット絵の合成の小道具は `tools/pixel-art.mjs` にまとめ、`make-tower-demo.mjs` と共有）。`apps/player/src/mansion-fixture.test.ts` が core の `step` で、通しプレイ（なぞなぞ・番号・鍵の間違いを含む）と、ろうそくのやり直し・寝室の扉・ネコの手がかりを確かめる。
- **haunted プロジェクト（おばけ屋敷の追いかけっこ）**：`fixtures/projects/v1/haunted`。玄関ホール（13×10。画面も 416×320）と 3 つの階（客間 17×12・回廊 21×13・地下室 21×15。画面より広いのでスクロールする）。戦闘は無く、歩き回るおばけを避けながら、階ごとのろうそく（4・5・6 本）を全部集める。おばけのページはトリガ「イベントから接触」（`eventTouch`）と `repeat` の `moveRoute` を持ち、おばけの方から触れてきたとき（プレイヤーから触れたときも）に捕まえた演出（`FlashScreen`・`ShakeScreen`・メッセージ）をして、その階の入口へ `TransferPlayer`（`fade: "black"`）する。同じマップへの場所移動なので、おばけも元の位置からやり直す。拾ったろうそくはセルフスイッチ A で消えたまま残る。おばけの種類は動き方だけが違う：あおい「おいかけ」（速さ 3 で `toward` を 3 歩・`random` を 1 歩。`skippable`）、しろい「きまぐれ」（`random` が多い）、ももいろの「見回り」（速さ 4 で廊下を左右に 16 歩ずつ往復。`skippable` でないので列がずれない）、むらさきの「かげろう」（`through` で壁を抜け、速さ 2 で近づく。絵は半透明）、あかい「いたずら」（速さ 5 で 3 歩近づき、速さ 3 で 2 歩離れる。`away`）。暗い色調は、マップごとの並列イベントが `TintScreen` を 1 秒ごとにかけ直す（色調はセーブされないので、ロードのあとも戻るように）。ろうそくは「下」プライオリティの接触イベントで、階ごとの変数（`var_c1`〜`var_c3`）がその階の本数に届くと `var_cleared`（`max(...)`）を進めて玄関ホールへ戻る。次の階の扉は「変数が○以上」で開き、終えた階には入れない。玄関ホールの大燭台は終えた階の数だけ灯り、3 つとも終えると色調が消えて明るくなり、エンディング（捕まった回数を出す）でタイトルに戻る。執事（進み具合で言うことが変わり、おばけの種類を教えてくれる）とはり紙もある。マップ・`project.json`・アセット（館のタイルセット・おばけと執事の歩行シート・ろうそくと大燭台の絵）はすべて `node tools/make-haunted-demo.mjs` が生成する（間取りは文字の計画を手で書き、入口からすべてのろうそくへ歩けることを生成時に確かめる。館とおばけの絵は「おばけ屋敷の鬼ごっこ」と同じ描き方）。`apps/player/src/haunted-fixture.test.ts` が core の `step` で、扉の鍵、色調、立ち止まっていても向こうから来て捕まえる・入口へ戻る・おばけが元の位置に戻る・ろうそくは残る、かげろうが壁にかこまれた所から抜け出す、いたずらが近づいては離れる、ろうそく集め役（おばけから離れた道を選ぶ）の通しプレイ（3 シード。捕まりながらでもエンディングまで行ける）を確かめる。
- **stealth プロジェクト（忍び込み！月影の宝物庫）**：`fixtures/projects/v1/stealth`。夜の屋敷 1 枚（`map_manor`、25×19。画面は 480×352 で、スクロールする）。中庭（草）・玄関の広間・左の兵舎・右の隊長の部屋・広間の奥の宝物庫からなり、侵入口（12, 17）から入って、右の部屋の宝箱のかぎで宝物庫の扉（12, 5）を開け、宝物庫の宝箱 3 つを取って、門（12, 18）から出る。戦闘は無い。見張りは 5 人：中庭の「見回りの兵」（16 歩ずつ往復。視界 5）、兵舎の「見張り」（向きを変えるだけの立ち番。視界 4）、右の部屋の「隊長」（立ち番。視界 6）、広間の「見張り」（立ち番。視界 5）、中庭の「番犬」（うろつく。視界 3）。どの見張りも 3 ページ：視界のページ（トリガ `eventSight`・`sightRange`・`moveRoute`。見つけたら `sw_seen_<番号>` を入れて「見つかった」の演出）→「見つけたとき」のおいかけるページ（`sw_seen_<番号>` が入ったら。トリガ `eventTouch`、`moveRoute` は `speed` と `chase`。触れたら `var_caught` を足し、盗んだ宝（`sw_got1`〜`3`・`var_loot`）と警戒のスイッチをすべて戻して、侵入口へ `TransferPlayer`。同じマップなので見張りも元の位置からやり直す）→「警報のとき」の同じ内容のページ（`sw_alert` が入ったら。番犬にだけ無い）。最後の宝箱を開けると `sw_alert` が入り、番犬以外の全員が追ってくる。見張りの視界をさえぎるのは、柱・木箱・たる・テーブル・茂み・閉じた宝物庫の扉（通れないもの）と壁で、立ち番のうしろ側は見えない。暗い色調は並列イベントの `TintScreen`（警報のあいだは赤）。マップ・`project.json`・アセット（夜の屋敷のタイルセット・見張りと番犬と相棒の歩行シート・宝箱と扉の絵）はすべて `node tools/make-stealth-demo.mjs` が生成する（間取りは文字の計画で、侵入口からすべての宝箱・かぎ・扉・見張りへ歩いて行けることを生成時に確かめる）。`apps/player/src/stealth-fixture.test.ts` が core の `step` で、視界の長さ・向き・うしろ・かげ、見つかって追われてつかまる・元の位置からやり直す、広間の見張りが戸口を抜けて追ってくる、かぎ→扉→宝 3 つ→警報、門（宝が足りない・そろった）、宝物庫から門まで走り抜けて逃げきれることを確かめる。
- **hokora プロジェクト（ほこらの冒険）**：`fixtures/projects/v1/hokora`。ミニ JRPG の一本道で、マップは 4 枚：村「ミルト村」（`map_village`、17×13。宿屋・よろず屋・村長・村人 2 人・看板。ここと「ほこら」では魔物に出会わない）、草原（`map_field`、26×22。南の出口から村へ、北の洞窟の口へ。まん中を川が横切り橋が 1 つ。木と花は固定のシードでまき、道のまわり 1 タイルは空ける。宝箱にポーション 2 個）、ほこらの洞窟（`map_cave`、21×17。入口の部屋・かぎの部屋・エーテルの宝箱のある東の広間・北の通路の封印の扉と階段）、ほこら（`map_shrine`、15×13。回復の泉と、奥のほこらの主）。画面は 480×352（15×11）。**ランダムエンカウント**：草原（`encounterStep` 18。スライム・こうもり・野犬の 5 つの敵グループ）と洞窟（`encounterStep` 13。こうもり・ガイコツ・野犬の 6 つ）に `encounters`（重みつき）。**メニュー**：`system.menuSkill: true` で「スキル」が並び、ミナのヒール・ヒールオール、メニューのアイテムから、傷ついた味方を回復できる。**宿屋**（やすらぎ亭）は 1 泊 15G（`ConditionalBranch` の式 `gold >= 15` で足りるか判定。足りれば `ChangeGold` で払って暗転 → 全回復）・「冒険を記録する」（`SaveGame`）・やめる。**よろず屋**は `ShopProcessing`（ポーション・ハイポーション・エーテル、売却可）。村長（はじまりのイベントのあとに話すと説明と支度金 50G・ポーション 3 個。かぎを取ったあとは台詞が変わる）。**進行**：洞窟のかぎの部屋の宝箱で `sw_key`、洞窟の北の通路の「封印の扉」（`sw_key` が無いと開かない。`sw_door`）、階段からほこらへ、泉（回復して `SaveGame` するか選べる）、ほこらの主（`BattleProcessing`、逃走不可・敗北可。勝つと `sw_boss` とエンディングのあと `ReturnToTitle`。負けると村に戻されて全回復し、また挑める）。ランダムエンカウントの全滅（`canLose: false`）はゲームオーバー。パーティは勇者（戦士。強打・かぶと割り）とミナ（僧侶。ヒール・ホーリー・ヒールオール）。味方 Lv5 でほこらの主に 8 割ほど勝てるように敵の強さを決めた（4 で 4 割、3 では勝てず、6 でほぼ勝てる）。マップ・`project.json`・アセット（草原・洞窟・ほこらのタイルセット・人と宝箱と看板と封印の扉・敵 5 種の絵・ほこらの主の歩行シート）はすべて `node tools/make-hokora-demo.mjs` が生成する（地形は計画から作り、村・草原・洞窟・ほこらの出入口・宝箱・扉・NPC へ歩いて行けることを生成時に確かめる。戦闘 BGM は「はじまりの村」と同じ）。`apps/player/src/hokora-fixture.test.ts` が core の `step` で、構造（4 枚のマップ・エンカウントの表・出入口の行き先）、村とほこらでは出会わない・草原を 400 歩歩くと 22 回ほど出会う、逃げると歩数が 0 に戻って 9 歩は安全、メニューのポーション・ヒール、宿屋（払う・足りない）、封印の扉（かぎが無いと開かない）、ほこらの主に負けると村に戻る、同じシードなら同じ場所で同じ敵に出会うこと、そして素直な作戦（`test-utils` の `autoBattle` と、メニューでの回復と、宿屋での休憩）で村から草原・洞窟・ほこらを抜けてほこらの主を倒してタイトルに戻るまでを確かめる。
- **デモを選ぶページ**：`tools/build-demos.mjs` の `DEMOS` から、一覧ページ（`index.html`）と、デモごとのフォルダ形式のプレイヤー（`village/`・`maze/`・`tower/`・`mansion/`・`haunted/`・`stealth/`・`hokora/`）を作る。サイトでは `demo/` の下に置き（`tools/build-site.mjs`）、`pnpm demo` は `apps/player/dist-demos/` に作って配信する。セーブはプロジェクトの `meta.id`（`demo` / `maze` / `tower` / `mansion` / `haunted` / `stealth` / `hokora`）ごとに分かれるので、同じオリジンでも混ざらない。
- **E2E**（`e2e/player.spec.ts`）：話しかけて戦闘 → 攻撃で勝利 → マップに戻って続きのイベント（画面のピクセル・報酬・Effect を確認）、逃走してもう一度戦う、戦闘中はメニューが開かずスキルで戦える。

## 実装メモ（M6 で確定した点）
- **エクスポータは新しいパッケージ `@rpg/exporter`**（`schema` と `project-store` にだけ依存。`editor-ui` が import できる。`apps/player` に置くと、エディタから読めない — アプリ同士は import できない — ため）。`exportGame(repo, projectId, { format, minifyJson?, warnAboveBytes? }, { js })` は `Result<{ bytes, mime, fileName, warnings }, ProjectStoreError>` を返す（`Blob` ではなくバイト列）。プレイヤー本体（`player.js` のソース）は呼び出し側が渡す。ストアに保存されている内容から作る（`load` を通るので検証・マイグレーション済み）。
- **フォルダ形式（ZIP）**：`index.html` / `player.js` / `project/project.json` / `project/maps/<MapId>.json` / `assets/<AssetId>.<ext>` / `README.txt`（置き方とキャッシュ：`assets/` は `Cache-Control: public, max-age=31536000, immutable` をすすめる）。`assets/` の拡張子はプレイヤーの `createHttpBytesSource` と同じ規則（名前の拡張子 → MIME → `bin`）。バイト列が無いアセットは警告して含めない。
- **単一 HTML**：`<script type="application/json" id="rpg-embedded">`（`{ project, maps, assets(base64), projectHash }`。`<` と行区切り文字は `\u` 形式にエスケープ）と、インラインの `<script type="module">`（`player.js`。`</script` と `<!--` はエスケープ）。favicon は `data:,` で、外部のファイルは一切読まない。16 MB（`warnAboveBytes`）を超えたら警告してフォルダ形式をすすめる。`projectHash` はフォルダ形式の `project.json` のバイト列の sha256 と同じ値（[inv-1] のテストがある）。`minifyJson: false` は `project.json` / マップの整形だけに効く。
- **`bootPlayer`**：`PlayerConfig` は `{ projectUrl?, embedded?, assetsUrl?, debug?, saveScope? }`（`projectUrl` か `embedded` のどちらか）。`embedded` があれば `createEmbeddedProjectSource`（検証は HTTP 版と同じ）と `createEmbeddedBytesSource`（09）を使い、通信しない。エントリ `main.ts` は `#rpg-embedded` があればそれで起動する（JSON が壊れていればエラーを表示）。
- **E2E**（`e2e/export.spec.ts`）：エディタで新規作成 → イベントを置く → 「配布物を書き出す…」でフォルダ形式と単一 HTML をダウンロード。ZIP は別実装（テスト内の最小の unzip）で構造を確かめ、**別のオリジン（ランダムなポートの静的サーバ）**で配信して、タイトル → 開始 → 話しかける → セーブ → リロード → コンティニュー → 歩く。単一 HTML は `file://` で同じシナリオを遊び、**リクエストがすべて `file://` / `data:` / `blob:` であること**を確かめる。
- **未対応**：`renderer`（`webgl` / `auto`）と `plugins`（M7）、Service Worker によるオフライン化（M7）、ローディングのタップ待ち画面（音声の解禁。`AudioContext` は最初の入力で生成する現状の作りのまま）、`saveScope` を書き出しの設定にすること（`project.meta.id` ごとにセーブが分かれるので、既定では混ざらない）。

## 実装メモ（M7 で確定した点）
- **`renderer`**：`PlayerConfig.renderer?: "canvas2d" | "webgl" | "auto"`（既定 `auto`）。`auto` は `isWebglAvailable()` が真なら WebGL、偽なら Canvas2D。`main.ts` は `?renderer=` か `#app` の `data-renderer`（書き出しが埋める）から決める。選ばれた方式は `<canvas data-renderer>` に出る。`webgl` を明示して使えなければエラー画面。WebGL のときの `preserveDrawingBuffer` は `?debug` のときだけ（ピクセルを読むため）。
- **エクスポータ**：`ExportOptions` に `renderer`（既定 `auto`。`data-renderer` になる）と `offline`（フォルダ形式のみ。単一 HTML では無効にして警告）を追加。エディタの書き出しダイアログに描画方式とオフラインの選択がある。
- **オフライン（Service Worker）**：`offline: true` で `sw.js` を同梱し、`index.html` に登録のスクリプトを入れる。`sw.js` は install で全ファイル（と `./`）をキャッシュへ入れ、activate で古い `rpg-` キャッシュを消し、GET・同一オリジンの取得をキャッシュ優先（無ければネットワーク）で返す。**キャッシュ名は配布物の全ファイルの内容ハッシュ**から決めるので、ゲームを置き直せば別のキャッシュになる。E2E `e2e/offline.spec.ts`：別オリジンで一度開いて有効にし、**サーバを止めてネットワークも切った**状態でリロードしても、タイトル → ニューゲームまで動く。
- **プラグイン**：`PlayerConfig.plugins`（09 ではなく 14）。単一 HTML でも同じ（プレイヤーに同梱したカタログから、`system.plugins` のものを読み込む）。
- **E2E**：`e2e/webgl.spec.ts`（demo を WebGL と Canvas2D で動かしてタイトル・マップの見た目を比べる。`--disable-3d-apis` のブラウザで `auto` が Canvas2D になり、`webgl` の明示はエラー画面）。ピクセルを 2D コンテキストから読む既存のプレイヤーの E2E は `?renderer=canvas2d` を指定するようにした。
- **未対応**：ローディングのタップ待ち画面（音声の解禁）、`saveScope` を書き出しの設定にすること。

## 実装メモ（GitHub Pages への公開）
- **公開先**：https://www.buko106.tokyo/cc-rpg-maker/ 。`/` がランディングページ（`site/index.html`。画像は `site/img/`）、`/editor/` がエディタ、`/demo/` が demo プロジェクト付きのプレイヤー。
- **ビルド**：`pnpm build:site`（`tools/build-site.mjs`）が `site-dist/`（git 管理外）に、エディタ（`apps/editor-ui/scripts/build-web.mjs`）・プレイヤー（`apps/player/scripts/build-web.mjs --project fixtures/projects/v1/demo`）・`site/` をまとめて出力し、`.nojekyll` を置く。`pnpm site` はビルドして http://127.0.0.1:4175/ で配信する。
- **サブパスで動く条件**：どの HTML も `editor.js` / `project/project.json` / `player/player.js` のように**相対パス**だけで参照する（`/` 始まりを使わない）。`tools/build-site.test.ts` が、出力の HTML に絶対パスが無いことと、ランディングのリンク先が実在することを確かめる。
- **デプロイ**：`.github/workflows/pages.yml`。`main` への push と手動実行（`workflow_dispatch`）で、ビルド → `actions/upload-pages-artifact` → `actions/deploy-pages`。**初回だけ**、リポジトリの Settings → Pages → Source を「GitHub Actions」にする。独自ドメイン（`www.buko106.tokyo`）はアカウント側の設定で、このリポジトリに `CNAME` は置かない。
- **保存先の注意**：エディタのプロジェクト（IndexedDB `rpg-projects`）とデモのセーブ（`rpg-saves-*`）は**オリジン単位**で、パスでは分かれない。同じドメインの別サイトが同じ名前を使うと混ざる。

### 実装メモ（スマホ用の操作パッド）
- 主入力が指の端末（`matchMedia("(pointer: coarse)")`）では、ゲーム画面の下に操作パッド（十字キー・決定・キャンセル・メニュー）を出す。`bootPlayer` の `touchPad`（`auto` / `on` / `off`）、`?touch=on|off` で上書きできる。仕組みは docs/08 を参照。
- iOS 対策：矢印・☰ は記号文字だと絵文字に化けるので SVG で描く。ダブルタップ/ピンチでページが拡大されないよう、パッド上の `touchstart` / `touchmove` と `gesturestart` の既定動作を止め、viewport に `maximum-scale=1, user-scalable=no` も付ける（iOS の Safari は touch-action だけでは止めきれない）。実機での確認はまだ。
- 画面の幅だけでなく高さにも収まるように拡大率を決める（横向きのスマホでも、ゲーム画面が切れない）。`index.html` は `viewport-fit=cover` と `overscroll-behavior: none`（引っ張って更新を防ぐ）。書き出しのテンプレートも同じ。
