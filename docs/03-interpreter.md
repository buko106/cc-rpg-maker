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
