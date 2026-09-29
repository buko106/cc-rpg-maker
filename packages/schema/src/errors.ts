export interface SchemaIssue {
  /** `maps.map_1.name` のようなドット区切りのパス。ルートは空文字列。 */
  path: string;
  message: string;
}

export type SchemaError =
  | { kind: "invalid"; issues: SchemaIssue[] }
  /** データの `formatVersion` がこのビルドの `CURRENT_FORMAT_VERSION` より新しい。 */
  | { kind: "newer-format"; found: number; supported: number }
  | { kind: "migration"; message: string };
