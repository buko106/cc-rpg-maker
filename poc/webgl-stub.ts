// PoC：WebGL を外した変種で `@rpg/render-webgl` の代わりに差し込む
export const isWebglAvailable = (): boolean => false;
export const createWebglRenderer = (): never => {
  throw new Error("この配布物には WebGL が入っていない");
};
