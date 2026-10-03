import * as z from "zod";

declare const brandSymbol: unique symbol;
/** 名前的型付け。ID を取り違えるとコンパイルエラーになる。 */
export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export type MapId = Brand<string, "MapId">;
export type EventId = Brand<string, "EventId">;
export type TilesetId = Brand<string, "TilesetId">;
export type ActorId = Brand<string, "ActorId">;
export type ClassId = Brand<string, "ClassId">;
export type SkillId = Brand<string, "SkillId">;
export type ItemId = Brand<string, "ItemId">;
export type EnemyId = Brand<string, "EnemyId">;
export type TroopId = Brand<string, "TroopId">;
export type CommonEventId = Brand<string, "CommonEventId">;
export type StateId = Brand<string, "StateId">;
/** 内容ハッシュ（sha256 先頭16桁）。形式のみ schema で検査し、実体との一致は `assets` が検証する。 */
export type AssetId = Brand<string, "AssetId">;
export type SwitchId = Brand<string, "SwitchId">;
export type VariableId = Brand<string, "VariableId">;

/**
 * ID に使える文字。`:` を含めないのは、セルフスイッチのキー `${MapId}:${EventId}:${key}` を
 * 曖昧さなく分解できるようにするため。
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 任意のブランド ID の zod スキーマ。実行時は形式検査のみ。
 * `ref` を渡すと、スキーマのメタデータ（`schema.meta()`）に `{ ref }` が付く。エディタがフォームを自動生成するとき、
 * 「これは `ref` の種類の ID だ」と分かって選択ウィジェットを出せる（docs/13-editor-ui.md）。値の検証には影響しない。
 */
export function idSchema<T extends string>(ref?: string): z.ZodType<Brand<string, T>> {
  const base = z.string().regex(ID_PATTERN, "ID は英数字・_・- のみ、1〜64 文字");
  return (ref === undefined ? base : base.meta({ ref })) as unknown as z.ZodType<Brand<string, T>>;
}

export const mapIdSchema = idSchema<"MapId">("map");
export const eventIdSchema = idSchema<"EventId">();
export const tilesetIdSchema = idSchema<"TilesetId">("tileset");
export const actorIdSchema = idSchema<"ActorId">("actor");
export const classIdSchema = idSchema<"ClassId">("class");
export const skillIdSchema = idSchema<"SkillId">("skill");
export const itemIdSchema = idSchema<"ItemId">("item");
export const enemyIdSchema = idSchema<"EnemyId">("enemy");
export const troopIdSchema = idSchema<"TroopId">("troop");
export const commonEventIdSchema = idSchema<"CommonEventId">("commonEvent");
export const stateIdSchema = idSchema<"StateId">("state");
export const switchIdSchema = idSchema<"SwitchId">("switch");
export const variableIdSchema = idSchema<"VariableId">("variable");
export const assetIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "AssetId は sha256 先頭16桁（小文字16進）")
  .meta({ ref: "asset" }) as unknown as z.ZodType<AssetId>;

/** `Record<Id, V>` の zod スキーマ。キーの形式も検査する。 */
export function idRecord<Id extends string, V extends z.ZodType>(value: V): z.ZodType<Record<Id, z.output<V>>> {
  return z.record(z.string().regex(ID_PATTERN), value) as unknown as z.ZodType<Record<Id, z.output<V>>>;
}

/** `newId` の乱数・時刻の供給源。テストでは固定値を渡して決定論的にする。 */
export interface IdSource {
  /** 現在時刻（Unix ms）。 */
  now(): number;
  /** `[0,1)` の乱数。 */
  random(): number;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function defaultSource(): IdSource {
  // schema は DOM lib を持たないため、Web Crypto は構造的型で参照する。
  const crypto = (globalThis as { crypto?: { getRandomValues<T extends Uint32Array>(a: T): T } }).crypto;
  if (crypto === undefined) throw new Error("newId: Web Crypto が無い環境では IdSource を渡すこと");
  return {
    now: () => Date.now(),
    random: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32,
  };
}

/**
 * `${prefix}_${ULID}` 形式の新しい ID を作る。ULID は時刻順に並ぶ（先頭10文字が時刻、残り16文字が乱数）。
 * @param prefix `[A-Za-z0-9]` のみ。長さは ID 全体で 64 文字以内に収まること。
 */
export function newId<T extends string>(prefix: string, source: IdSource = defaultSource()): Brand<string, T> {
  const id = `${prefix}_${ulid(source)}`;
  if (!ID_PATTERN.test(id) || /[^A-Za-z0-9]/.test(prefix)) throw new Error(`newId: 不正な prefix: ${prefix}`);
  return id as Brand<string, T>;
}

function ulid(source: IdSource): string {
  let time = Math.floor(source.now());
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }
  let randomPart = "";
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD[Math.floor(source.random() * 32)]!;
  return timePart + randomPart;
}
