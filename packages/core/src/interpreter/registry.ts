import { err, ok } from "@rpg/schema";
import type { CommandError, CommandHandler, CommandRegistry } from "./handler.js";

export function createCommandRegistry(): CommandRegistry {
  const handlers = new Map<string, CommandHandler<any>>();
  return {
    register(h) {
      if (handlers.has(h.code)) throw new Error(`コマンドが二重登録された: ${h.code}`);
      handlers.set(h.code, h);
    },
    get: (code) => handlers.get(code),
    list: () => [...handlers.values()],
    validate(cmd) {
      const h = handlers.get(cmd.code);
      if (h === undefined) return err<CommandError>({ kind: "unknownCommand", code: cmd.code });
      const r = h.params.safeParse(cmd.params);
      if (r.success) return ok(undefined);
      return err<CommandError>({
        kind: "invalidParams",
        code: cmd.code,
        issues: r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      });
    },
  };
}
