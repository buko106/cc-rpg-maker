# 03. `@rpg/core` — イベントインタプリタ・CommandHandler・Effect

## 責務
- `EventCommand[]` を1命令ずつ実行する状態機械（インタプリタ）。
- コマンドの意味論を `CommandHandler` として登録・検索するレジストリ。
- 組み込みコマンド一式の実装。
- 待機（メッセージ、ウェイト、移動完了、戦闘終了）を**状態として**表現する。

## 非責務
- コマンドのUI（エディタのフォーム）。→ 13。ただしフォーム生成に必要なメタデータは本パッケージが提供する。
- 描画・音の実行。→ Effect として発行し `runtime` に委ねる。

## 依存が許されるパッケージ
`@rpg/schema`、同パッケージ内の 02/04/05。

## 公開インターフェース

### InterpreterState
```ts
export interface InterpreterState {
  readonly id: string;
  readonly origin: { kind: "mapEvent"; mapId: MapId; eventId: EventId; page: number }
                 | { kind: "commonEvent"; id: CommonEventId }
                 | { kind: "troop"; troopId: TroopId; page: number }
                 | { kind: "plugin"; name: string };
  readonly mode: "normal" | "parallel";
  readonly commands: readonly EventCommand[];
  readonly pc: number;                       // 次に実行する命令のインデックス
  readonly wait: WaitState;                  // { kind: "none" } | { kind: "frames"; left } | { kind: "message" } | { kind: "choice" } | { kind: "move"; who } | { kind: "battle" } | { kind: "transfer" } | { kind: "child"; id }
  readonly branch: Record<number, number>;   // indent → 選択された分岐番号（Choice / Conditional 用）
  readonly callStack: { commands: readonly EventCommand[]; pc: number; branch: Record<number,number> }[];
  readonly locals: Record<string, unknown>;  // プラグイン用
}
```

### CommandHandler とレジストリ
```ts
export interface CommandHandler<P = unknown> {
  readonly code: string;
  readonly params: z.ZodType<P>;             // params の検証とエディタのフォーム生成に使う
  readonly meta: {
    label: string; category: string;         // エディタ表示用
    describe(p: P, view: ProjectView): string;   // イベントリストの1行表示
    refs(p: P): RefTarget[];                 // 参照整合性チェック用（01 の collectRefs に渡す）
  };
  /** 命令を実行する。純関数。 */
  run(p: P, ctx: CommandCtx): CommandResult;
  /** wait 中に毎フレーム呼ばれ、解除条件を判定する。省略時は wait.kind に応じた既定処理。 */
  resume?(p: P, ctx: CommandCtx): CommandResult;
}

export interface CommandCtx {
  readonly state: GameState;
  readonly interp: InterpreterState;
  readonly project: ProjectView;
  readonly rng: Random;
  readonly eval: (expr: string, scope?: Record<string, unknown>) => Result<Value, EvalError>;  // 05
  readonly input: InputFrame;
}

export type CommandResult = {
  state?: GameState;                         // 変更があれば
  effects?: Effect[];
  control?: { kind: "next" }                 // pc+1（既定）
           | { kind: "jump"; pc: number }
           | { kind: "wait"; wait: WaitState }
           | { kind: "call"; commands: EventCommand[] }   // コモンイベント呼び出し
           | { kind: "exit" }                             // このインタプリタ終了
           | { kind: "skipBlock"; indent: number };       // 同 indent の次の分岐終端まで飛ぶ
};

export interface CommandRegistry {
  register(h: CommandHandler<any>): void;    // 同じ code の二重登録はエラー
  get(code: string): CommandHandler | undefined;
  list(): CommandHandler[];
  validate(cmd: EventCommand): Result<void, CommandError>;
}
export function createCommandRegistry(): CommandRegistry;
export function registerBuiltins(r: CommandRegistry): void;
```

### インタプリタ実行
```ts
export function startInterpreter(state: GameState, origin: InterpreterState["origin"], commands: EventCommand[], mode: "normal"|"parallel"): GameState;
export function runInterpreters(state: GameState, input: InputFrame, ctx: Ctx): StepResult;
// 1フレーム分。normal モードは1つだけ動き、命令はブロックされるまで連続実行する（最大 N=1000 命令/フレームで打ち切り、warn Effect）。
```

## 組み込みコマンド一覧（`code` と主な params）

| code | params | 備考 |
|---|---|---|
| `ShowText` | `{ text, face?, position, background }` | `wait: message` |
| `ShowChoices` | `{ choices: string[], cancel }` | `wait: choice`、結果を `branch[indent]` へ |
| `ChoiceBranch` | `{ index }` | 内部用：`branch[indent] !== index` なら skipBlock |
| `InputNumber` / `SelectItem` | | |
| `ControlSwitches` | `{ ids, value }` | |
| `ControlVariables` | `{ ids, op, operand }` | operand は定数/変数/乱数/式 |
| `ControlSelfSwitch` | `{ key, value }` | |
| `ControlTimer` | | |
| `ConditionalBranch` | `{ condition }` | 条件は 05 の式 or 構造化条件 |
| `Else` / `EndBranch` | | 内部用 |
| `Loop` / `BreakLoop` / `EndLoop` | | |
| `ExitEventProcessing` | | `control: exit` |
| `CallCommonEvent` | `{ id }` | `control: call` |
| `Label` / `JumpToLabel` | `{ name }` | |
| `Wait` | `{ frames }` | |
| `TransferPlayer` | `{ mapId, x, y, dir, fade }` | `wait: transfer`。MapData 未ロードなら `requestMapData` |
| `SetMoveRoute` | `{ target, route, wait }` | |
| `ChangeGold` / `ChangeItems` / `ChangeParty` / `ChangeHp` / `ChangeLevel` … | | |
| `ChangeBgm` / `PlaySe` / `FadeoutBgm` | | Effect のみ |
| `ShakeScreen` / `FlashScreen` / `TintScreen` / `Fadein` / `Fadeout` | | Effect + 一時状態 |
| `BattleProcessing` | `{ troop, canEscape, canLose }` | 04 へ遷移、`wait: battle`、結果を branch へ |
| `ShopProcessing` | | |
| `SaveGame` / `LoadGame` / `GameOver` / `ReturnToTitle` | | Effect |
| `Script` | `{ expr }` | 05 の式言語で **副作用付き関数**（`setVar` 等）のみ許可 |
| `Comment` | | no-op |

新規コマンドは `plugin:<pluginName>/<Code>` の `code` で登録する（14）。

## 不変条件
1. インタプリタは `runInterpreters` 1回で最大 N 命令しか進まない（無限ループ耐性）。
2. `wait.kind !== "none"` の間 `pc` は変化しない。
3. 分岐系コマンドは `indent` の整合が取れていれば必ず終端に到達する（`skipBlock` が末尾を越えたら `exit`）。
4. `CommandHandler.run` は純関数：同入力に同出力。
5. 未登録 `code` は実行時に `warn` Effect を出してスキップする（クラッシュしない）。

## テスト要件
- 各組み込みコマンドに対する**テーブル駆動テスト**：`(state, params, input) → (state', effects, control)`。`test-utils/interpreterHarness.ts` に「コマンド列を与えて完了まで回す」ヘルパを置く。
- 分岐/ループ/ラベルの制御フロー：ネストした `ConditionalBranch` × `Loop` の組み合わせを fast-check で生成し、必ず終了することを検証。
- 待機解除：`ShowText` が `ok` トリガで進む、`Wait` が指定フレーム後に進む。
- 並列イベントが normal を阻害しないこと。
- `validate` が params の型違いを検出すること。

## 完了条件
- 組み込みコマンドがすべて登録され、`fixtures/projects/v1/commands-smoke.json`（全コマンドを1回ずつ使うイベント）がエラーなく完走する。
- 上記テストが通る。

## 実装メモ（M1 で確定した点）
- **M1 で実装済みのコマンド**：`ShowText` / `ControlSwitches` / `ControlVariables` / `ConditionalBranch`（+ 内部用 `Else` / `EndBranch`）/ `Wait` / `TransferPlayer`。残りは M6。
- **待機**：`wait` を返したコマンドは `pc` を進めない。解除は `resume`（省略時は `wait.kind` に応じた既定処理）が判定し、`next` を返すと `pc + 1` へ進む。`frames` の `left` は毎フレーム 1 減り、`left <= 1` のフレームで解除される（`Wait N` は N フレーム後に続きを実行）。
- **`CommandResult.setBranch`**（追加）：`interp.branch` への書き込み。`ConditionalBranch` が選ばれた側（真 = 0、偽 = 1）を `branch[indent]` に書き、`Else` はそれを見て本体を実行するか `EndBranch` まで飛ぶ。
- **`skipBlock`**：同じ indent の次の `Else` / `EndBranch` に `pc` を移す（その命令は実行される）。見つからなければインタプリタを終了する。
- **`ShowText`**：他のインタプリタがメッセージを出している間は 1 フレーム待って再試行する。閉じられるのは決定/キャンセル（入力フェーズ）。
- **`ControlVariables`**：`div` は切り捨て除算、`div` / `mod` の除数が 0 のときは変数を変えない（MV 互換）。式オペランドが評価できなければ警告を出して変更しない。
- **`ConditionalBranch`** の条件は式（文字列）か構造化条件（`switch` / `variable`）。式が評価できない・真偽値でないときは警告を出して偽として扱う。
- **1 フレームの命令数の上限**（`MAX_COMMANDS_PER_FRAME = 1000`）はインタプリタごと。超えると警告を出して打ち切り、次のフレームで続ける。
- `normal` は同時に 1 つ。`startInterpreter` は、すでに動いていれば何もしない。

## 実装メモ（M4 で確定した点）
- **追加したコマンド**：`BattleProcessing { troop, canEscape = true, canLose = false }` と `ChoiceBranch { index }`。
- **`BattleProcessing`**：マップシーンで、トループが存在するときだけ戦闘を始める（`startBattle`）。`system.bgm.battle` があれば `playBgm`（フェード 300ms）を発行し、`wait: battle` で待つ。`resume` は戦闘中（`scene` が `map` でない間）待ち続け、マップに戻ったら `locals.battleResult`（`leaveBattle` が書く）から分岐番号を決めて `branch[indent]` に書き（勝利 0 / 逃走 1 / 敗北 2。中断・結果なしは逃走と同じ 1）、次の命令へ進む。ゲームオーバーになったときはインタプリタが戻らない。
- **`ChoiceBranch`**：`branch[indent] === index` のときだけ続く本体を実行し、違えば `skipBlock`。`skipBlock` の飛び先（`BLOCK_ENDS`）に `ChoiceBranch` を加えたので、本体の終わりで次の `ChoiceBranch` に着いても、選ばれていなければ次の `ChoiceBranch` / `EndBranch` へ飛ぶ。イベントは `BattleProcessing` の後に `ChoiceBranch 0`（勝利）→ `ChoiceBranch 1`（逃走）→ `ChoiceBranch 2`（敗北）→ `EndBranch`（本体は 1 段深い indent）と並べる。将来の `ShowChoices` の分岐にも使う。
- 戦闘中は `runInterpreters` を呼ばない（マップの並列イベントも止まる）ので、待機中のインタプリタの `pc` は変わらない。

## 実装メモ（M5 で確定した点）
- `params` の zod にエディタ向けのメタデータを付けた：`ShowText.text` は `{ multiline: true }`、`ConditionalBranch.condition`（式の文字列）は `{ formula: true }`。ID を取る params は 01 の `ref` メタデータを持つ ID スキーマを使う。プラグインのコマンドも同じ方法で自動フォームに載る（13）。

## 実装メモ（M6 で確定した点）
- **全コマンドが登録済み**（`BUILTIN_COMMANDS`。表のコマンドに加え、内部用の `ChoiceBranch` / `MoveStep`）。`fixtures/projects/v1/commands-smoke/`（`commands-smoke.json` の代わりに、エディタのプロジェクトと同じ形のフォルダ）の `ev_smoke` が、`Comment` から `Script` まで一通りを使って警告なしに完走する。ほかのイベント（`ev_transfer` / `ev_battle` / `ev_save` / `ev_load` / `ev_gameover` / `ev_title`）は、シーンを動かすコマンド用。「レジストリの全コマンドがこのマップのどこかで使われている」ことと「全コマンドの params が zod を通る」ことをテストで固定している。
- **`CommandResult` の追加**：`setLocals`（`interp.locals` への書き込み。値が `undefined` のキーは消す）。**`CommandCtx` の追加**：`script(expr)`（`script` モードで評価して変更操作を返す。`Script` コマンドが `setVar` / `setSwitch` / `gainItem` を状態に反映する）。
- **フロー**：`Loop` / `EndLoop`（`EndLoop` は対応する `Loop` へ戻る。入れ子は数えて対応を取る）、`BreakLoop`（内側のループの `EndLoop` の次へ。ループの外なら警告）、`ExitEventProcessing`（呼び出し元があっても全部終わる）、`CallCommonEvent`（深さ 16 まで。超えたら警告してスキップ）、`Label` / `JumpToLabel`（同じコマンド列の中で最初の同名ラベル。無ければ警告）、`Comment`。無限ループは 1 フレーム 1000 命令の上限で止まり、毎フレーム警告する。ネストした `Loop` × `ConditionalBranch` が必ず終わることは fast-check で確かめている。
- **ゲーム進行**：`ControlSelfSwitch`（マップイベントの中だけ）、`ControlTimer`、`ChangeGold` / `ChangeItems`（量は定数か変数。0 未満にならない）、`ChangeParty`、`ChangeHp`（既定は 1 で止まる。`allowDeath` で 0 まで。戦闘不能には効かない）/ `ChangeMp` / `ChangeExp`（増やすだけ）/ `ChangeLevel`（1〜99。経験値はそのレベルの下限に合わせ、HP/MP は新しい最大値に収める）。対象は `"party"`（既定）かアクター ID。
- **選択肢と入力**：`ShowChoices { choices, cancel }` は選ばれた番号を `branch[indent]` に書き、続く `ChoiceBranch { index }`（選択肢の数だけ）と `EndBranch` の並びで分岐する（`BattleProcessing` と同じ）。`cancel` は `"disallow"`（既定）かキャンセルで選ばれたことにする番号。`InputNumber { variable, digits }` は変数に入れる。`SelectItem { variable, kind }` は所持品（`key` = 大事なもの、`all`）から選ばせ、**アイテム ID の昇順での 1 始まりの番号**（キャンセル・所持なしは 0）を変数に入れる（変数は数値だけなので）。`ShopProcessing { goods }` はメッセージ欄の選択肢（商品と「やめる」）で、所持金の範囲で 1 個ずつ買う（専用のショップ画面は作っていない）。他のインタプリタがメッセージ欄を使っている間は、1 フレーム待って再試行する。
- **`SetMoveRoute { target, route, wait }`**：ルートを内部用の `MoveStep` に展開して実行する。`target` は `"player"` / `"this"`（既定）/ イベント ID。`wait` が真で `repeat` でなければ、`call` でこのインタプリタの中で 1 歩ずつ実行して終わるまで待つ。それ以外は並列のインタプリタ（`origin = plugin "moveRoute:<who>"`）に任せ、同じ対象の実行中のルートは置き換える。`MoveStep` は、動いている間は待ち、通れなければ `skippable` ならあきらめ、そうでなければ最大 60 フレーム待ってから警告してあきらめる。動かす対象がマップから居なくなったらルートごと終わる。
- **ページの `moveRoute`（自律移動）**：有効なページが `moveRoute` を持っていれば、`syncEventInterpreters` がそのページ専用の並列インタプリタ（起点 `plugin "pageRoute:<eventId>:<page>"`）を起動し、ページが無効になる・別のマップへ移ると止める。ルートは `pageRouteCommands` が `auto: true` の `MoveStep` に展開する（`repeat` は `Loop`。1 周ごとに 1 フレーム待つので、時間のかからない歩だけのルートでも詰まらない。`repeat` でなければ一度だけ実行して、ページが変わるまで待ち続ける＝再起動しない）。`auto` の歩は、通常のインタプリタの実行中・メッセージ表示中・場所移動の予約中・`SetMoveRoute` でそのイベントを動かしている間は止まり（RPG ツクールと同じ）、プレイヤーの居るタイルには入らず（`through` か下のプライオリティなら入る）、通れなくても警告しない（`skippable` でなければ最大 60 フレーム待って次の歩へ）。`random` は共有の乱数から決めるので、同じシードなら同じ動きになる。状態に足したものは無く、既存のリプレイのハッシュは変わらない。デモの町（`fixtures/projects/v1/demo`）では、ネコ（ランダムに歩く）とヒヨコ（同じ行を往復する）がこれで動く（絵は `tools/make-demo-assets.mjs` が作る）。デモに動くイベントが増えたので、デモを使う戦闘のリプレイ（`battle-win` / `battle-escape`）の「インタプリタが空」の確認は「2 つだけ（この 2 匹の自律移動）」に、期待ハッシュは作り直した。
- **音・画面**：`ChangeBgm` / `PlaySe` / `FadeoutBgm` は Effect のみ。`ShakeScreen` / `FlashScreen` / `TintScreen` / `Fadeout` / `Fadein` は Effect を発行し、`wait` が真で時間があればその分待つ（色は r/g/b が 0〜255、a が 0〜1。`Fadeout` / `Fadein` の `wait` の既定は真）。
- **システム**：`SaveGame` / `LoadGame` はメニューのセーブ/ロード画面を開く（`scene` を `menu` にするだけ。閉じるとマップに戻り、続きから実行される）、`GameOver`（ゲームオーバー画面へ。インタプリタは全部消える）、`ReturnToTitle`（状態を作り直してタイトルへ）、`Script { expr }`（副作用は `setVar` / `setSwitch` / `gainItem` のみ）。
