import { switchIdSchema, variableIdSchema } from "@rpg/schema";
import { z } from "zod";

/** 複数のコマンドで共通の params 部品。 */
export const switchIds = z.array(switchIdSchema).min(1);
export const variableIds = z.array(variableIdSchema).min(1);
export const comparison = z.enum([">=", "==", "<="]);
