import { describe, expect, it } from "vitest";
import type { AudioOut, AudioRef } from "@rpg/runtime";
import type { ContractFactory } from "./contract.js";

const ref = (asset: string, loop = true): AudioRef => ({ asset: asset as never, volume: 0.8, pitch: 1, loop });

/**
 * AudioOut の契約スイート。すべての AudioOut アダプタが通さなければならない（docs/08-audio-input.md の不変条件）。
 * 不変条件 1（BGM の多重再生防止）は実際の再生ノード数が要るので、各アダプタのテストで検証する。
 */
export function audioOutContract(name: string, make: ContractFactory<AudioOut>): void {
  describe(`AudioOut contract: ${name}`, () => {
    it("[inv-3] どの順序で呼んでも例外を出さない（再生前の停止・連打・音量変更）", async () => {
      const a = await make();
      expect(() => {
        a.stopBgm();
        a.stopBgm(500);
        a.playBgm(ref("aaaaaaaaaaaaaaaa"));
        a.playBgm(ref("aaaaaaaaaaaaaaaa"));
        a.playBgm(ref("bbbbbbbbbbbbbbbb"), 1000);
        a.playSe(ref("cccccccccccccccc", false));
        a.setMasterVolume(0.5);
        a.setMasterVolume(0);
        a.stopBgm(200);
      }).not.toThrow();
      a.dispose();
    });

    it("[inv-2] dispose 後の呼び出しは no-op（例外を出さない）", async () => {
      const a = await make();
      a.dispose();
      expect(() => {
        a.playBgm(ref("aaaaaaaaaaaaaaaa"));
        a.stopBgm();
        a.playSe(ref("cccccccccccccccc", false));
        a.setMasterVolume(1);
        a.dispose();
      }).not.toThrow();
    });
  });
}
