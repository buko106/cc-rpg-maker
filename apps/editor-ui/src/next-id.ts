/** `prefix_001` 形式で、まだ使われていない ID（最小の連番）。 */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `${prefix}_${String(n).padStart(3, "0")}`;
    if (!used.has(id)) return id;
  }
}
