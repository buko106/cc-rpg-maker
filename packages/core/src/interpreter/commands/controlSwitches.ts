import * as z from "zod";
import { defineCommand } from "../handler.js";
import { switchIds, switchName } from "./params.js";

/** `initial` はエディタで新しく作るときの初期値（検証には影響しない）。 */
const params = z.strictObject({ ids: switchIds, value: z.boolean().meta({ initial: true }) });

export const controlSwitches = defineCommand({
  code: "ControlSwitches",
  params,
  meta: {
    label: "スイッチの操作",
    category: "ゲーム進行",
    describe: (p, view) => `スイッチ ${p.ids.map((id) => switchName(view, id)).join(", ")} = ${p.value ? "ON" : "OFF"}`,
    refs: (p) => p.ids.map((id) => ({ kind: "switch", id })),
  },
  run(p, c) {
    const switches = { ...c.state.switches };
    for (const id of p.ids) switches[id] = p.value;
    return { state: { ...c.state, switches } };
  },
});
