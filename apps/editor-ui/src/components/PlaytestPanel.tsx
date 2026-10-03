import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { isCoarsePointer } from "@rpg/input-browser";
import { useEnv, useSession } from "../hooks.js";
import type { Playtest, PlaytestStart } from "../playtest.js";
import { Dialog } from "./Dialog.js";

/**
 * テストプレイ。編集中の文書（`session.projectSource()`）でゲームを起動し、閉じたら止める。
 * セーブはメモリ上に置かれ、本番のセーブデータには触れない。
 */
export function PlaytestPanel({ start, onClose }: { start?: PlaytestStart; onClose: () => void }): ReactElement {
  const session = useSession();
  const env = useEnv();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRootRef = useRef<HTMLDivElement>(null);
  const touch = isCoarsePointer();
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<"starting" | "running">("starting");
  const { width, height } = session.doc.project.system.screen;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let cancelled = false;
    let playtest: Playtest | undefined;
    env.startPlaytest(session, canvas, start, padRootRef.current ?? undefined).then(
      (pt) => {
        if (cancelled) {
          pt.stop();
          return;
        }
        playtest = pt;
        (window as unknown as { __rpgPlaytest?: unknown }).__rpgPlaytest = pt.runtime;
        setStatus("running");
        canvas.focus();
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
      playtest?.stop();
      delete (window as unknown as { __rpgPlaytest?: unknown }).__rpgPlaytest;
    };
    // 起動はパネルを開いたときの文書のスナップショットで行う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog title="テストプレイ" onClose={onClose} wide>
      <p className="muted" aria-live="polite">
        {error !== undefined ? "" : status === "starting" ? "起動しています…" : touch ? "操作：画面下の十字キーで移動、A で決定、B でキャンセル、☰ でメニュー。" : "操作：矢印キーで移動、Enter／Z で決定、Esc／X でメニュー・キャンセル。"}
        {start !== undefined && ` 開始位置：${session.doc.project.maps[start.mapId]?.name ?? start.mapId} (${start.x}, ${start.y})`}
      </p>
      {error !== undefined && <p role="alert" className="notice error">テストプレイを起動できませんでした：{error}</p>}
      <canvas
        ref={canvasRef}
        className="playtest-canvas"
        tabIndex={0}
        aria-label="テストプレイの画面"
        width={width}
        height={height}
        style={{ width: width * 2, maxWidth: "100%", aspectRatio: `${width}/${height}` }}
      />
      <div ref={padRootRef} />
    </Dialog>
  );
}
