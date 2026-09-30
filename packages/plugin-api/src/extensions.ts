import { defaultBattleRules } from "@rpg/core";
import type { Ctx } from "@rpg/core";
import type { Logger, RuntimeExtensions } from "@rpg/runtime";
import { noopLogger } from "@rpg/runtime";
import type { PluginRegistry } from "./types.js";

/**
 * 読み込んだプラグインの登録内容から、ランタイムに渡す拡張を作る。
 * - `setup`：`Ctx` のコマンド・式関数に登録し、戦闘ルールを（組み込みの上に）重ねる。何も登録が無ければ `Ctx` をそのまま返す。
 * - `onPluginEffect` / `afterProject`：受け口・後処理を読み込み順に呼ぶ。例外は握りつぶさずに警告してゲームを続ける。
 * プラグインを 0 個読み込んだ状態と、何も登録しないプラグインを読み込んだ状態は、同じ結果になる。
 */
export function toRuntimeExtensions(registry: PluginRegistry, logger: Logger = noopLogger): RuntimeExtensions {
  return {
    setup(ctx: Ctx): Ctx {
      for (const c of registry.commands) ctx.commands.register(c);
      for (const f of registry.formulas) ctx.formulas.registerFn(f.name, f.fn, { sideEffect: f.sideEffect });
      if (Object.keys(registry.battleRules).length === 0) return ctx;
      return { ...ctx, battleRules: { ...defaultBattleRules, ...ctx.battleRules, ...registry.battleRules } };
    },
    onPluginEffect(effect, api) {
      for (const handler of registry.effectHandlers.get(effect.name) ?? []) {
        try {
          handler(effect.payload, api);
        } catch (e) {
          logger.warn(`plugin effect ${effect.name} の受け口が失敗した: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!registry.effectHandlers.has(effect.name)) logger.warn(`plugin effect ${effect.name}: 受け口が登録されていない`);
    },
    afterProject(scene, frame, state) {
      let current = frame;
      for (const hook of registry.projectionHooks) {
        if (hook.scene !== scene) continue;
        try {
          current = hook.fn(current, state);
        } catch (e) {
          logger.warn(`プラグインの投影の後処理が失敗した: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return current;
    },
  };
}
