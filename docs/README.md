# ブラウザ版 RPGツクール・クローン 設計ドキュメント（ルート）

本ドキュメント群は、ブラウザ上で動作するRPG制作ツール（エディタ）と、そのランタイム（プレイヤー）の設計を定義する。
コーディングエージェントが**1パッケージ分の実装を、対応するサブドキュメント1本を読むだけで着手できる**粒度で分割している。

## 読み方

1. まず `00-principles.md` を読む。全パッケージに適用される依存ルール・命名規約・テスト規約がある。
2. 担当するパッケージのドキュメントを読む。各ドキュメントは以下の共通構成をもつ。
   - **責務** / **非責務**
   - **依存が許されるパッケージ**（これ以外を import してはならない）
   - **公開インターフェース**（TypeScript のシグネチャ。実装はこれに合わせる）
   - **不変条件**（テストで検証されるべき性質）
   - **テスト要件**
   - **完了条件**
3. 他パッケージの型が必要なら、そのパッケージのドキュメントの「公開インターフェース」節だけを参照する。内部実装に依存してはならない。

## ドキュメント一覧

| # | ファイル | パッケージ | 内容 |
|---|---|---|---|
| 00 | [00-principles.md](./00-principles.md) | 全体 | 設計原則、依存ルール、規約、用語集 |
| 01 | [01-schema.md](./01-schema.md) | `@rpg/schema` | プロジェクトデータ型、バリデーション、マイグレーション |
| 02 | [02-core-state.md](./02-core-state.md) | `@rpg/core` | GameState、Action/Reducer、Random/Clock ポート、Snapshot |
| 03 | [03-interpreter.md](./03-interpreter.md) | `@rpg/core` | イベントインタプリタ、CommandHandler、Effect |
| 04 | [04-battle.md](./04-battle.md) | `@rpg/core` | 戦闘システム（ターン解決、ダメージ、状態異常） |
| 05 | [05-expression.md](./05-expression.md) | `@rpg/core` | 数式・条件式の安全な評価器 |
| 06 | [06-runtime.md](./06-runtime.md) | `@rpg/runtime` | ゲームループ、シーン管理、FrameSpec 投影 |
| 07 | [07-render.md](./07-render.md) | `@rpg/render-*` | Renderer ポートと Canvas2D / WebGL / Null アダプタ |
| 08 | [08-audio-input.md](./08-audio-input.md) | `@rpg/audio-*`, `@rpg/input-*` | AudioOut / InputSource ポートとアダプタ |
| 09 | [09-assets.md](./09-assets.md) | `@rpg/assets` | AssetSource ポート、ローダ、キャッシュ |
| 10 | [10-project-store.md](./10-project-store.md) | `@rpg/project-store` | ProjectRepository（ゲーム定義の永続化） |
| 11 | [11-save-store.md](./11-save-store.md) | `@rpg/save-store` | SaveRepository（セーブデータの永続化） |
| 12 | [12-editor-core.md](./12-editor-core.md) | `@rpg/editor-core` | EditorCommand、Undo/Redo、整合性チェック |
| 13 | [13-editor-ui.md](./13-editor-ui.md) | `@rpg/editor-ui` | エディタUI（マップ/DB/イベント編集、テストプレイ） |
| 14 | [14-plugin-api.md](./14-plugin-api.md) | `@rpg/plugin-api` | プラグイン境界と PluginHost |
| 15 | [15-player-export.md](./15-player-export.md) | `@rpg/player` | 配布用シェルとエクスポータ |
| 16 | [16-testing.md](./16-testing.md) | 全体 | テスト戦略、共通テストユーティリティ、契約テスト |
| 17 | [17-milestones.md](./17-milestones.md) | 全体 | 実装順序、マイルストーン、各段階の完了条件 |
| 18 | [18-dungeon-plugin.md](./18-dungeon-plugin.md) | `@rpg/plugin-dungeon` | 不思議のダンジョンのプラグイン（デモ実装済み）と、そのために core に足した汎用の部品 |
| 19 | [19-fishing-plugin.md](./19-fishing-plugin.md) | `@rpg/plugin-fishing` | 釣り大会（ミニゲーム・図鑑・制限時間つきの大会）のプラグイン（デモ実装済み）と、そのために core に足した「プラグインの待機」 |

## システム概要

```
┌───────────────────────────────────────────────────────────────────┐
│  apps                                                              │
│   editor-ui (React)                     player (配布シェル)          │
├───────────────────────────────────────────────────────────────────┤
│  editor-core            runtime (ループ / シーン / FrameSpec 投影)   │
├───────────────────────────────────────────────────────────────────┤
│  adapters : render-canvas2d / render-webgl / render-null            │
│             audio-webaudio / audio-null                             │
│             input-browser / input-script                            │
│             project-store(idb, fsa, zip, mem)  save-store(idb, mem) │
│             assets(http, opfs, zip, embedded)                       │
├───────────────────────────────────────────────────────────────────┤
│  core  : GameState / Interpreter / Battle / Expression / Snapshot   │
│          ← ポート: Random, Clock                                    │
├───────────────────────────────────────────────────────────────────┤
│  schema: Project 型 / zod / migrations                              │
└───────────────────────────────────────────────────────────────────┘
        依存は常に下向き。adapters は上位のポート型にのみ依存する。
```

## 中核となる4つの決定

1. **ヘキサゴナル**：`schema → core → runtime → adapters/apps`。core と schema はブラウザAPIを一切 import しない。
2. **決定論**：乱数・時刻・入力はすべて注入。同じ入力列は同じ状態を生む。リプレイがゴールデンテストになる。
3. **2種類の永続化を分離**：ゲーム定義（`ProjectRepository`）とプレイ状態（`SaveRepository`）は別パッケージ・別契約。
4. **描画は FrameSpec 経由**：エンジンは「何を描くか」（純データ）だけを出力し、「どう描くか」はアダプタが担う。

## リポジトリ構成

```
/
├── docs/                 ← 本ドキュメント群
├── packages/
│   ├── schema/
│   ├── core/
│   ├── runtime/
│   ├── render-canvas2d/  render-webgl/  render-null/
│   ├── audio-webaudio/   audio-null/
│   ├── input-browser/    input-script/
│   ├── assets/
│   ├── project-store/
│   ├── save-store/
│   ├── editor-core/
│   ├── plugin-api/       ← プラグインの土台（PluginHost・ローダ）。プラグイン自体は plugins/
│   └── test-utils/       ← 16-testing.md 参照
├── plugins/              ← プラグインの実装（plugin-api だけに依存する。第三者のプラグインと同じ立場）
│   ├── samples/          ← @rpg/plugin-samples
│   ├── dungeon/          ← @rpg/plugin-dungeon（18-dungeon-plugin.md）
│   └── fishing/          ← @rpg/plugin-fishing（19-fishing-plugin.md）
├── apps/
│   ├── editor-ui/
│   └── player/
└── fixtures/             ← サンプルプロジェクト、各バージョンのマイグレーション用データ
```

pnpm workspace + TypeScript（strict）+ Vitest + Playwright + fast-check を標準とする。
