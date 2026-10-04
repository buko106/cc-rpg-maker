# 20. 難易度調整の bot（`@rpg/bot`）

## 責務
- ゲームを**人と同じ入力**（十字キーと決定）で自動に遊び、何回も試して、難易度の目安（勝率・ターン数・HP の残り）を数字にする。
- 作戦（`BattlePolicy`）を差し替えられるようにし、どのゲームのデータにも使える既定の作戦を持つ。
- 端末から使う入口（`pnpm bot`）と、テストから使う入口（`simulateBattles` など）を持つ。

## 非責務
- 敵やアイテムの数値を自動で直すこと（数字を見て直すのは作る人。bot は目安を出すだけ）。
- マップを歩く・謎を解く（いまは戦闘だけ。マップの道のりは各デモのテストが持つ。後続の候補）。

## 依存が許されるパッケージ
- `core`, `schema`（00 の依存ルール）。ブラウザでも Node でも動く。端末の入口（`src/cli.ts`）だけは Node 専用で、`index.ts` からは出さない。

## 公開インターフェース
```ts
// 戦い方：味方 1 人ぶんの行動を選ぶ。決定的であること（同じ状態なら同じ行動）
type BattlePolicy = (turn: BattleTurn) => BattleChoice;
interface BattleTurn { state: GameState; battle: BattleState; actor: Battler; skills: readonly Skill[]; items: readonly Item[]; ctx: Ctx }
interface BattleChoice { kind: "attack" | "skill" | "item" | "guard"; skill?: string; item?: string; target?: BattlerId }

battleBotInput(state, ctx, policy): InputFrame                // 1 フレーム分の入力
runBattle(state, ctx, policy, maxFrames?): BattleRun           // 戦闘シーンを出るまで戦う（outcome / turns / frames / party）

attackPolicy, guardPolicy, smartPolicy(options?), POLICIES    // 作戦
prepareParty(state, ctx, { level?, equips?, items?, fullRecover? }): GameState
simulateBattles(state, ctx, { troop, runs, policy?, seed?, party?, canEscape? }): BattleReport
levelSweep(state, ctx, levels, options): LevelRow[]            // レベルごとの BattleReport
lowestLevel(rows, minWinRate), formatLevelTable(rows)
```

## 実装メモ
- **人と同じ経路**：`runBattle` は `core.step` に入力を渡して進めるだけで、状態を直接いじらない。コマンドの選択は、カーソルを十字キーで合わせて決定する（`battleBotInput`）。解決中・結果表示は決定で送り、敵グループのバトルイベント（04）のメッセージも決定で送る（選択肢は先頭）。戦闘の前からマップに出ていたメッセージには触らない。選べない行動（MP の足りないスキル・持っていないアイテム）は通常攻撃に読み替える。終わらない戦闘（`maxFrames`、既定 30000 フレーム）は例外にする。
- **作戦**：
  - `attackPolicy`：通常攻撃だけ（いちばん弱った敵を狙う）。いちばん素朴な遊び方の目安。
  - `guardPolicy`：防御だけ。負けるまでの流れを見るのに使う。
  - `smartPolicy({ healBelow = 0.5, useItems = true })`：ふつうに遊ぶ人の目安。スキルの範囲と効果だけを見て決めるので、どのゲームにも使える。① 倒れた味方を蘇生のスキル（`one-dead-ally`）で起こす ② HP が `healBelow` 未満の味方が 2 人以上なら全体回復、1 人なら単体回復（回復のスキル。無ければ回復アイテム）③ 敵を狙うスキルのうち消費 MP がいちばん大きいもの（敵が 2 体以上なら全体攻撃を優先。回復のスキルを持つ人は、そのいちばん安い MP を残す）④ 通常攻撃。対象はいつもいちばん弱った敵。回復のスキルかどうかは `healsHp`（HP 回復の効果があるか、味方向けで式が負）で見分ける。
  - ゲームごとの作戦は `BattlePolicy` を書けばよい（デモのテストの `fight` など）。
- **試行**（`simulateBattles`）：`prepareParty` でパーティを整え（レベルと経験値・装備・全快・持ち物）、`runs` 回、乱数の種を `<seed>:<回数>` に変えて戦う。戦闘の乱数は種から決まるので、**同じデータ・同じ種なら毎回同じ結果**（テストに書ける）。負けてもゲームオーバーにしない（`canLose`）。各回は同じ状態から始め直すので、経験値やドロップは持ち越さない。作戦は逃走を選ばない。
- **まとめ**（`BattleReport`）：勝ち・負けの数と勝率、勝った戦闘の平均と最長のターン数、勝った戦闘のパーティの HP の残り（最大 HP の合計に対する、残り HP の合計の割合）の平均と最小。
- **装備**（`PartySetup.equips`）：アクターごとにアイテム ID を並べる（欄はアイテムから決まる。02 の `equipSlotOf`）。持ち物は減らさない。付けられないもの・いないアクターは例外。

## 端末から使う（`pnpm bot`）
```
pnpm bot <プロジェクトのフォルダ | fixtures の名前> --troop <ID[,ID…]|all>
         [--levels 3-8 | 1,5,9] [--runs 30] [--policy smart|attack|guard] [--seed bot]
         [--items potion:3,ether:1] [--equip actor_hero:wp_iron,actor_mina:wp_rod] [--json]
```
- フォルダ形式（`project.json` と `maps/`）を読む。名前だけなら `fixtures/projects/v1/<名前>`。パーティはプロジェクトの初期パーティ（`system.initialParty`）。`--levels` を省くと、いまのレベル（いちばん高い人）で 1 行だけ。
- `tools/bot.mjs` が `packages/bot/src/cli.ts` を esbuild でまとめて、そのまま動かす（ビルドは要らない）。
- 例（ほこらの冒険のボス。各 60 回）：
  ```
  $ pnpm bot hokora --troop tr_boss --levels 3-7 --runs 60
  ■ ほこらの主（tr_boss）  パーティ：勇者・ミナ  作戦：smart  各 60 回
  Lv  勝率  平均ターン  最長ターン  残りHP(平均)  残りHP(最小)
  3   0%    -           13          -             -
  4   12%   10.1        13          39%           5%
  5   73%   9.1         11          52%           3%
  6   98%   7.6         9           57%           5%
  7   100%  6.6         8           67%           38%
  ```

## 難易度の目安をテストにする
- 試行は決定的なので、目安をそのままテストに書ける。デモの目安は `packages/bot/src/demos.test.ts`（`[calibration]`）：ほこらの主は Lv3 ではまず勝てず（1 割以下）、Lv5 で五分以上（5〜9 割）、Lv6 ならほぼ勝てる（9 割以上）、Lv4 では店の装備で勝ち目が出る。データを変えて外れたら、`pnpm bot` で表を見て、数値かテストの目安を直す。
- 同じファイルで、ほこらの主の戦いのバトルイベントが順に動くこと（名乗り → HP 半分で増援 → 25% で変身）も確かめる。

## テスト
- `bot.test.ts`：作戦どおりの操作で勝つ・防御だけなら負ける・バトルイベントのメッセージを送る・終わらなければ例外、作戦（回復・アイテム・全体攻撃・MP を残す・蘇生）、`prepareParty`、試行の決定性とまとめ、レベルを変えた試行と表。
- `cli.ts` の引数の読み方と出力は `cli.test.ts`。
- `test-utils` の `autoBattle` は `runBattle` を使う（デモのテストの通しプレイも同じ経路で戦う）。

## 後続の候補
- マップの道のり（歩く・話す・宝箱）も bot で進め、「村からボスまで通しで遊んだときのレベル・所持金」を数字にする。いまはデモのテストが、それぞれ自前の `route` / `settle` で持っている。
- エディタから試行する（敵グループの画面で「bot で試す」）。
