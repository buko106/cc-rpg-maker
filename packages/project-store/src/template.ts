import { CURRENT_FORMAT_VERSION } from "@rpg/schema";
import type { AssetEntry, AssetId, MapData, MapId, Project } from "@rpg/schema";
import type { ProjectDocument } from "./ports/projectRepository.js";
import { TEMPLATE_TILESET_BASE64, TEMPLATE_TILESET_ID, TEMPLATE_WALK_BASE64, TEMPLATE_WALK_ID } from "./template-assets.js";
import { assetEntryOf, base64ToBytes } from "./util.js";

export interface TemplateAsset {
  id: AssetId;
  bytes: ArrayBuffer;
  entry: AssetEntry;
}

export interface Template {
  doc: ProjectDocument;
  assets: TemplateAsset[];
}

export const TEMPLATE_MAP_ID = "map_001" as MapId;
export const TEMPLATE_MAP_SIZE = { width: 20, height: 15 } as const;

const PARAMS = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"] as const;

/**
 * 新規プロジェクトの雛形：草原の 1 マップ、勇者 1 人、タイルセット 1 つ。
 * すぐにテストプレイできること（開始位置・初期パーティ・タイル画像・歩行グラフィック）が条件。
 */
export function createTemplate(id: string, title: string, nowIso: string): Template {
  const tileset = base64ToBytes(TEMPLATE_TILESET_BASE64);
  const walk = base64ToBytes(TEMPLATE_WALK_BASE64);
  const assets: TemplateAsset[] = [
    { id: TEMPLATE_TILESET_ID as AssetId, bytes: tileset, entry: assetEntryOf(tileset, "tileset.png", "image") },
    { id: TEMPLATE_WALK_ID as AssetId, bytes: walk, entry: assetEntryOf(walk, "hero.png", "image") },
  ];
  const { width, height } = TEMPLATE_MAP_SIZE;
  const cells = width * height;
  const map = {
    id: TEMPLATE_MAP_ID,
    width,
    height,
    tileset: "ts_default",
    layers: [
      { name: "下層", tiles: new Array<number>(cells).fill(1) },
      { name: "上層", tiles: new Array<number>(cells).fill(0) },
    ],
    events: {},
  } as unknown as MapData;

  const project = {
    formatVersion: CURRENT_FORMAT_VERSION,
    meta: { id, title, createdAt: nowIso, updatedAt: nowIso },
    system: {
      startMap: TEMPLATE_MAP_ID,
      startX: 5,
      startY: 5,
      initialParty: ["actor_001"],
      tileSize: 32,
      screen: { width: 480, height: 320 },
      bgm: {},
      terms: {},
    },
    maps: { [TEMPLATE_MAP_ID]: { id: TEMPLATE_MAP_ID, name: "MAP001", order: 0 } },
    tilesets: {
      ts_default: {
        id: "ts_default",
        name: "基本",
        image: { asset: TEMPLATE_TILESET_ID },
        // 0 空 / 1 草 / 2 石壁（通行不可）/ 3 砂 / 4 木の床 / 5 花 / 6 扉
        passage: [15, 15, 0, 15, 15, 15, 15],
      },
    },
    database: {
      actors: {
        actor_001: { id: "actor_001", name: "勇者", classId: "class_001", initialLevel: 1, walk: { asset: TEMPLATE_WALK_ID }, equips: {} },
      },
      classes: {
        class_001: {
          id: "class_001",
          name: "戦士",
          params: Object.fromEntries(PARAMS.map((p) => [p, p === "mhp" ? { base: 100, growth: 10 } : p === "mmp" ? { base: 20, growth: 2 } : { base: 10, growth: 2 }])),
          skills: [],
        },
      },
      skills: {},
      items: {},
      enemies: {},
      troops: {},
      states: {},
      commonEvents: {},
    },
    assets: { entries: Object.fromEntries(assets.map((a) => [a.id, a.entry])) },
    switches: {},
    variables: {},
  } as unknown as Project;

  return { doc: { project, maps: { [TEMPLATE_MAP_ID]: map }, revision: 0 }, assets };
}
