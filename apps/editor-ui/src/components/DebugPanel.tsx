import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { Runtime } from "@rpg/runtime";
import type { ActorId, ItemId, MapId } from "@rpg/schema";
import { debugCommands, runDebug } from "../debug-commands.js";
import { useSession } from "../hooks.js";

const entries = <T extends { name: string }>(table: Readonly<Record<string, T>>): [string, T][] => Object.entries(table);
const label = (id: string, name: string): string => (name === "" ? id : `${name}（${id}）`);

/**
 * テストプレイ中のデバッグパネル：スイッチ・変数の切り替え、所持金・アイテム・仲間の追加、場所の移動。
 * 操作は `runDebug`（イベントコマンドとして実行）。表示は一定間隔で `runtime.getState()` から読み直す。
 * ここでのキー入力はゲームに渡さない（数値の入力中に矢印や Z で動いてしまわないように）。
 */
export function DebugPanel({ runtime }: { runtime: Runtime }): ReactElement {
  const session = useSession();
  const { project } = session.doc;
  const [, refresh] = useState(0);
  useEffect(() => {
    const id = setInterval(() => refresh((n) => n + 1), 300);
    return () => clearInterval(id);
  }, []);
  const state = runtime.getState();
  const maps = entries(project.maps);
  const items = entries(project.database.items);
  const actors = entries(project.database.actors);
  const switches = entries(project.switches);
  const variables = entries(project.variables);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [gold, setGold] = useState("100");
  const [item, setItem] = useState<string>(items[0]?.[0] ?? "");
  const [count, setCount] = useState("1");
  const [actor, setActor] = useState<string>(actors[0]?.[0] ?? "");
  const [mapId, setMapId] = useState<string>(state.map.mapId);
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const num = (v: string): number => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

  return (
    <details
      className="playtest-debug"
      onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <summary>デバッグ</summary>
      <section aria-label="スイッチ">
        <h3>スイッチ</h3>
        {switches.length === 0 && <p className="muted">スイッチがありません。</p>}
        {switches.map(([id, sw]) => (
          <label key={id} className="debug-row">
            <input type="checkbox" checked={state.switches[id as never] === true} onChange={(e) => runDebug(runtime, [debugCommands.setSwitch(id as never, e.target.checked)])} />
            {label(id, sw.name)}
          </label>
        ))}
      </section>
      <section aria-label="変数">
        <h3>変数</h3>
        {variables.length === 0 && <p className="muted">変数がありません。</p>}
        {variables.map(([id, v]) => {
          const current = String(state.variables[id as never] ?? 0);
          const commit = (): void => {
            const text = draft[id];
            if (text === undefined) return;
            runDebug(runtime, [debugCommands.setVariable(id as never, num(text))]);
            setDraft(({ [id]: _done, ...rest }) => rest);
          };
          return (
            <div key={id} className="debug-row">
              <label>
                {label(id, v.name)}
                <input type="number" value={draft[id] ?? current} onChange={(e) => setDraft({ ...draft, [id]: e.target.value })} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
              </label>
            </div>
          );
        })}
      </section>
      <section aria-label="所持品">
        <h3>所持金・アイテム・仲間</h3>
        <p className="muted">所持金：{state.party.gold}</p>
        <div className="debug-row">
          <input type="number" aria-label="増やす所持金" value={gold} onChange={(e) => setGold(e.target.value)} />
          <button type="button" onClick={() => runDebug(runtime, [debugCommands.addGold(num(gold))])}>所持金を増やす</button>
        </div>
        <div className="debug-row">
          <select aria-label="アイテム" value={item} onChange={(e) => setItem(e.target.value)}>
            {items.map(([id, it]) => (
              <option key={id} value={id}>
                {label(id, it.name)}（持っている数：{state.party.items[id as never] ?? 0}）
              </option>
            ))}
          </select>
          <input type="number" aria-label="アイテムの数" value={count} onChange={(e) => setCount(e.target.value)} />
          <button type="button" disabled={item === ""} onClick={() => runDebug(runtime, [debugCommands.addItem(item as ItemId, num(count))])}>アイテムを増やす</button>
        </div>
        <div className="debug-row">
          <select aria-label="アクター" value={actor} onChange={(e) => setActor(e.target.value)}>
            {actors.map(([id, a]) => (
              <option key={id} value={id}>
                {label(id, a.name)}
              </option>
            ))}
          </select>
          <button type="button" disabled={actor === ""} onClick={() => runDebug(runtime, [debugCommands.addMember(actor as ActorId)])}>仲間にする</button>
        </div>
      </section>
      <section aria-label="場所の移動">
        <h3>場所の移動</h3>
        <p className="muted">
          いまの場所：{state.map.name} ({state.map.player.x}, {state.map.player.y})
        </p>
        <div className="debug-row">
          <select aria-label="移動先のマップ" value={mapId} onChange={(e) => setMapId(e.target.value)}>
            {maps.map(([id, m]) => (
              <option key={id} value={id}>
                {label(id, m.name)}
              </option>
            ))}
          </select>
          <input type="number" min={0} aria-label="移動先の X" value={x} onChange={(e) => setX(e.target.value)} />
          <input type="number" min={0} aria-label="移動先の Y" value={y} onChange={(e) => setY(e.target.value)} />
          <button type="button" onClick={() => runDebug(runtime, [debugCommands.warp(mapId as MapId, Math.max(0, num(x)), Math.max(0, num(y)))])}>移動</button>
        </div>
      </section>
    </details>
  );
}
