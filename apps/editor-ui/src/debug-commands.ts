import type { Runtime } from "@rpg/runtime";
import type { ActorId, EventCommand, ItemId, MapId, SwitchId, VariableId } from "@rpg/schema";

/**
 * テストプレイ中のデバッグ操作（docs/13-editor-ui.md「テストプレイのデバッグパネル」）。
 * 操作は、ふつうのイベントコマンドとして走らせる（状態の更新・ページの再評価・場所移動は本物のコマンドと同じ道を通る）。
 */
const command = (code: string, params: Record<string, unknown>): EventCommand => ({ code, params, indent: 0 });

export const debugCommands = {
  setSwitch: (id: SwitchId, value: boolean): EventCommand => command("ControlSwitches", { ids: [id], value }),
  setVariable: (id: VariableId, value: number): EventCommand => command("ControlVariables", { ids: [id], op: "set", operand: { kind: "constant", value } }),
  /** 所持金を `amount` 増やす（負なら減らす）。 */
  addGold: (amount: number): EventCommand => command("ChangeGold", { op: amount >= 0 ? "gain" : "lose", amount: { kind: "constant", value: Math.abs(Math.trunc(amount)) } }),
  /** アイテムを `count` 個増やす（負なら減らす）。 */
  addItem: (item: ItemId, count: number): EventCommand => command("ChangeItems", { item, op: count >= 0 ? "gain" : "lose", amount: { kind: "constant", value: Math.abs(Math.trunc(count)) } }),
  addMember: (actor: ActorId): EventCommand => command("ChangeParty", { actor, op: "add" }),
  /** 暗転なしでマップの位置へ移動する（向きはそのまま）。 */
  warp: (mapId: MapId, x: number, y: number): EventCommand => command("TransferPlayer", { mapId, x, y, dir: "retain", fade: "none" }),
};

/** `commands` を、デバッグ用のインタプリタとして走らせる。 */
export function runDebug(runtime: Runtime, commands: readonly EventCommand[]): void {
  runtime.dispatch({ type: "interpreter", op: "start", origin: { kind: "plugin", name: "debug" }, commands, mode: "normal" });
}
