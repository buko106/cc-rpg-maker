/** 文字列の sha256（hex）。`crypto.subtle` が使えない環境では例外（ブラウザ・Node 20+ には有る）。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
