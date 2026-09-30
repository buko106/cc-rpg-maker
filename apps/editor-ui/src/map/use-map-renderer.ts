import type { EditorSession } from "@rpg/editor-core";
import type { AssetSource, Renderer } from "@rpg/runtime";
import type { MapData, Project } from "@rpg/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { EditorEnv } from "../hooks.js";
import { assetsOf, projectMapForEditor } from "./project-map.js";

/**
 * `canvas` に、ゲームと同じ `Renderer` でマップを描く（`projectMapForEditor` の `FrameSpec`）。
 * Renderer はセッション（と環境）が変わるまで使い回し、マップの内容が変わったときだけ描き直す。
 * 画像の読み込みが終わったら、もう一度描く（Renderer は未ロードの画像を次のフレームから描く）。
 */
export function useMapRenderer(canvas: RefObject<HTMLCanvasElement | null>, session: EditorSession, env: EditorEnv, project: Project, map: MapData | undefined): void {
  const engine = useRef<{ renderer: Renderer; assets: AssetSource; ready: boolean; loaded: Set<string>; lastFrame?: ReturnType<typeof projectMapForEditor> } | undefined>(undefined);
  const [readyTick, setReadyTick] = useState(0);
  const tileSize = project.system.tileSize;
  const width = (map?.width ?? 1) * tileSize;
  const height = (map?.height ?? 1) * tileSize;

  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const assets = env.createAssets(session);
    const renderer = env.createRenderer(el);
    const state = { renderer, assets, ready: false, loaded: new Set<string>() };
    engine.current = state;
    void renderer.init({ width, height, assets }).then(() => {
      state.ready = true;
      setReadyTick((n) => n + 1); // 初期化が終わったので描く
    });
    return () => {
      engine.current = undefined;
      renderer.dispose();
    };
    // Renderer の作り直しはセッションの切り替え時だけ（サイズは下の effect で追随する）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, env]);

  // マップの内容が変わったときだけ、Renderer で描き直す（ホバーの移動では描き直さない）
  const frame = useMemo(() => (map === undefined ? undefined : projectMapForEditor(project, map)), [project, map]);
  useEffect(() => {
    const state = engine.current;
    if (state === undefined || !state.ready || frame === undefined) return;
    state.renderer.resize(width, height);
    state.lastFrame = frame;
    state.renderer.render(frame);
    for (const id of assetsOf(frame)) {
      if (state.loaded.has(id)) continue;
      state.loaded.add(id);
      state.assets.loadImage(id).then(
        () => requestAnimationFrame(() => engine.current === state && state.lastFrame !== undefined && state.renderer.render(state.lastFrame)),
        () => state.loaded.delete(id),
      );
    }
  }, [frame, width, height, readyTick]);
}
