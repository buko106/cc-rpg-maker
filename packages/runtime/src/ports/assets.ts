import type { AssetId } from "@rpg/schema";

declare const imageBrand: unique symbol;
declare const audioBrand: unique symbol;

/**
 * デコード済み画像。runtime から見ると不透明な型。
 * canvas2d アダプタは `ImageBitmap` として扱う（`handle as unknown as ImageBitmap`。docs/09-assets.md）。
 */
export interface ImageHandle {
  readonly [imageBrand]: true;
}

/** デコード済み音声。webaudio アダプタは `AudioBuffer` として扱う。 */
export interface AudioHandle {
  readonly [audioBrand]: true;
}

export type AssetErrorKind = "notFound" | "hashMismatch" | "decodeFailed" | "network";

/** `AssetSource` が reject するエラー。`kind` で原因を判別する。 */
export class AssetError extends Error {
  readonly kind: AssetErrorKind;
  readonly id: AssetId;

  constructor(kind: AssetErrorKind, id: AssetId, message?: string) {
    super(message ?? `asset ${id}: ${kind}`);
    this.name = "AssetError";
    this.kind = kind;
    this.id = id;
  }
}

/** アセット（画像・音声・JSON）の取得口。実装は `@rpg/assets`（docs/09-assets.md）。 */
export interface AssetSource {
  loadImage(id: AssetId): Promise<ImageHandle>;
  loadAudio(id: AssetId): Promise<AudioHandle>;
  loadJson<T>(id: AssetId): Promise<T>;
  has(id: AssetId): Promise<boolean>;
}
