/**
 * メモリ上の `FileSystemDirectoryHandle` のふり（OPFS / File System Access API の代わり）。
 * ProjectRepository のディレクトリ版を Node で契約テストにかけるために使う。ブラウザと同じ振る舞いをする範囲：
 * - 無い名前は `NotFoundError`、種類の違う名前（ファイルをフォルダとして開く等）は `TypeMismatchError`。
 * - `createWritable` の書き込みは `close()` で初めて反映される（`abort()` なら捨てる）。
 * - `removeEntry` は、空でないフォルダに `recursive` なしだと `InvalidModificationError`。
 */

class FsError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

interface FileNode {
  kind: "file";
  data: Uint8Array;
}
interface DirNode {
  kind: "directory";
  children: Map<string, FileNode | DirNode>;
}
type Node = FileNode | DirNode;

const toBytes = (data: unknown): Uint8Array => {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  throw new FsError("TypeError", "書き込めない型");
};

export interface FakeDirectory extends FileSystemDirectoryHandle {
  /** テスト用：書き込みの失敗を仕込む。次の `createWritable().close()` が指定の例外で失敗する。 */
  failNextWrite(error: Error): void;
  /** テスト用：中身の一覧（`a/b/c.json` の形の相対パス、ソート済み）。 */
  paths(): string[];
}

export function createFakeDirectory(): FakeDirectory {
  const root: DirNode = { kind: "directory", children: new Map() };
  let failure: Error | undefined;

  const fileHandle = (name: string, node: FileNode): FileSystemFileHandle =>
    ({
      kind: "file",
      name,
      getFile: () => Promise.resolve(new File([node.data.slice()], name)),
      createWritable: () => {
        let pending: Uint8Array | undefined;
        return Promise.resolve({
          write(data: unknown) {
            pending = toBytes(data);
            return Promise.resolve();
          },
          abort: () => {
            pending = undefined;
            return Promise.resolve();
          },
          close() {
            if (failure !== undefined) {
              const e = failure;
              failure = undefined;
              return Promise.reject(e);
            }
            if (pending !== undefined) node.data = pending;
            return Promise.resolve();
          },
        });
      },
    }) as unknown as FileSystemFileHandle;

  const dirHandle = (name: string, node: DirNode): FakeDirectory => {
    const handle = {
      kind: "directory",
      name,
      getDirectoryHandle(child: string, opts?: { create?: boolean }) {
        const existing = node.children.get(child);
        if (existing?.kind === "file") return Promise.reject(new FsError("TypeMismatchError", `${child} はファイル`));
        if (existing !== undefined) return Promise.resolve(dirHandle(child, existing));
        if (opts?.create !== true) return Promise.reject(new FsError("NotFoundError", `${child} が無い`));
        const created: DirNode = { kind: "directory", children: new Map() };
        node.children.set(child, created);
        return Promise.resolve(dirHandle(child, created));
      },
      getFileHandle(child: string, opts?: { create?: boolean }) {
        const existing = node.children.get(child);
        if (existing?.kind === "directory") return Promise.reject(new FsError("TypeMismatchError", `${child} はフォルダ`));
        if (existing !== undefined) return Promise.resolve(fileHandle(child, existing));
        if (opts?.create !== true) return Promise.reject(new FsError("NotFoundError", `${child} が無い`));
        const created: FileNode = { kind: "file", data: new Uint8Array() };
        node.children.set(child, created);
        return Promise.resolve(fileHandle(child, created));
      },
      removeEntry(child: string, opts?: { recursive?: boolean }) {
        const existing = node.children.get(child);
        if (existing === undefined) return Promise.reject(new FsError("NotFoundError", `${child} が無い`));
        if (existing.kind === "directory" && existing.children.size > 0 && opts?.recursive !== true) {
          return Promise.reject(new FsError("InvalidModificationError", `${child} は空ではない`));
        }
        node.children.delete(child);
        return Promise.resolve();
      },
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        for (const [child, n] of [...node.children]) yield [child, n.kind === "file" ? fileHandle(child, n) : dirHandle(child, n)];
      },
      failNextWrite(error: Error) {
        failure = error;
      },
      paths() {
        const out: string[] = [];
        const walk = (prefix: string, d: DirNode): void => {
          for (const [child, n] of d.children) {
            if (n.kind === "file") out.push(`${prefix}${child}`);
            else walk(`${prefix}${child}/`, n);
          }
        };
        walk("", node);
        return out.sort();
      },
    };
    return handle as unknown as FakeDirectory;
  };

  return dirHandle("", root);
}

export type { Node as FakeNode };
