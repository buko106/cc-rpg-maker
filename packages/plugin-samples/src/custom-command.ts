import { z } from "@rpg/plugin-api";
import type { Diagnostic, PluginModule } from "@rpg/plugin-api";

const params = z.strictObject({
  min: z.number().int().min(0),
  max: z.number().int().min(0),
});

/**
 * サンプルプラグイン 2：独自のイベントコマンド `plugin:custom-command/RandomGold`（所持金を min〜max のランダムな額だけ増やす）と、
 * 式関数 `twice(n)`、`plugin` Effect の受け口 `custom-command/notice`、エディタの診断（min > max の警告）。
 * 乱数は共有のストリーム（`ctx.rng`）から引くので、リプレイで同じ結果になる。
 */
export const customCommandPlugin: PluginModule = {
  name: "custom-command",
  version: "1.0.0",
  register(host) {
    host.commands.add({
      code: "RandomGold",
      params,
      meta: {
        label: "ランダムな所持金",
        category: "プラグイン",
        describe: (p) => `所持金 +${p.min}〜${p.max}`,
        refs: () => [],
      },
      run(p, c) {
        const lo = Math.min(p.min, p.max);
        const hi = Math.max(p.min, p.max);
        const gained = c.rng.int(lo, hi);
        return {
          state: { ...c.state, party: { ...c.state.party, gold: c.state.party.gold + gained } },
          effects: [{ kind: "plugin", name: "custom-command/notice", payload: { gained } }],
        };
      },
    });

    host.formulas.addFn("twice", (args) => {
      const n = args[0];
      if (args.length !== 1 || typeof n !== "number") throw new Error("twice(n): 数値を 1 つ渡す");
      return n * 2;
    });

    host.effects.on("custom-command/notice", (payload) => {
      const gained = (payload as { gained?: unknown }).gained;
      host.log.info(`所持金が ${String(gained)} 増えた`);
    });

    host.editor?.diagnostics((doc) => {
      const out: Diagnostic[] = [];
      for (const map of Object.values(doc.maps)) {
        for (const ev of Object.values(map.events)) {
          ev.pages.forEach((page, pageIndex) =>
            page.commands.forEach((c, commandIndex) => {
              if (c.code !== "plugin:custom-command/RandomGold") return;
              const { min, max } = c.params as { min?: number; max?: number };
              if (typeof min === "number" && typeof max === "number" && min > max) {
                out.push({ severity: "warning", code: "randomGoldRange", message: `RandomGold の最小 (${min}) が最大 (${max}) より大きい`, location: { mapId: map.id, eventId: ev.id, page: pageIndex, commandIndex } });
              }
            }),
          );
        }
      }
      return out;
    });
  },
};
