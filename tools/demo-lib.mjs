/**
 * デモ生成スクリプト（make-*-demo.mjs）が共有する、コマンド・ページ・イベントの組み立て部品。
 * どれも project.json / maps/*.json に出る形をそのまま返す小さな関数で、生成物はこの部品の有無で変わらない。
 */
/** JSON を 2 スペースで整形し、数値だけの配列は 1 行にまとめる（既存のフィクスチャと同じ体裁）。 */
export const toJson = (value) => `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_, body) => `[${body.split(/,\s*/).join(", ")}]`)}\n`;
export const cmd = (code, params, indent = 0) => ({ code, params, indent });
export const text = (t, indent = 0) => cmd("ShowText", { text: t, position: "bottom", background: "window" }, indent);
export const page = (p) => ({ conditions: [], trigger: "action", through: false, priority: "same", ...p });
export const sw = (id, value = true) => ({ kind: "switch", id, value });
export const setSwitch = (ids, value, indent = 0) => cmd("ControlSwitches", { ids: [].concat(ids), value }, indent);
export const ifExpr = (expr, indent = 0) => cmd("ConditionalBranch", { condition: expr }, indent);
export const otherwise = (indent = 0) => cmd("Else", {}, indent);
export const endBranch = (indent = 0) => cmd("EndBranch", {}, indent);
export const flash = (color, duration, indent = 0) => cmd("FlashScreen", { color, duration }, indent);
export const hidden = (p) => page({ trigger: "parallel", through: true, priority: "below", ...p });
export const entry = (name, a) => ({ name, kind: "image", mime: "image/png", size: a.size, width: a.width, height: a.height });
export const params = Object.fromEntries(["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"].map((p) => [p, { base: p === "mhp" ? 100 : p === "mmp" ? 20 : 10, growth: 2 }]));
export const event = (id, name, { x, y }, pages) => ({ id, name, x, y, pages });
export const addVar = (id, value, indent = 0) => cmd("ControlVariables", { ids: [id], op: "add", operand: { kind: "constant", value } }, indent);
export const setVar = (id, value, indent = 0) => cmd("ControlVariables", { ids: [id], op: "set", operand: { kind: "constant", value } }, indent);
export const ifVar = (id, op, value, indent = 0) => cmd("ConditionalBranch", { condition: { kind: "variable", id, op, value } }, indent);
export const curve = (base, growth) => ({ base, growth });
