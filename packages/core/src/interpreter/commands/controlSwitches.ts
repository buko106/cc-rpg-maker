import { z } from "zod";
import { defineCommand } from "../handler.js";
import { switchIds } from "./params.js";

const params = z.strictObject({ ids: switchIds, value: z.boolean() });

export const controlSwitches = defineCommand({
  code: "ControlSwitches",
  params,
  meta: {
    label: "スイッチの操作",
    category: "ゲーム進行",
    describe: (p) => `スイッチ ${p.ids.join(", ")} = ${p.value ? "ON" : "OFF"}`,
    refs: (p) => p.ids.map((id) => ({ kind: "switch", id })),
  },
  run(p, c) {
    const switches = { ...c.state.switches };
    for (const id of p.ids) switches[id] = p.value;
    return { state: { ...c.state, switches } };
  },
});
