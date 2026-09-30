import { useEffect, useState } from "react";
import type { AssetId } from "@rpg/schema";
import { useSession } from "../hooks.js";

/** アセットのバイト列から作った Blob URL（画像のプレビュー・パレット用）。無い・作れない環境では `undefined`。 */
export function useAssetUrl(id: AssetId | undefined): string | undefined {
  const session = useSession();
  const [url, setUrl] = useState<string | undefined>();
  const entry = id === undefined ? undefined : session.doc.project.assets.entries[id];
  const mime = entry?.mime;
  useEffect(() => {
    if (id === undefined || mime === undefined || typeof URL.createObjectURL !== "function") {
      setUrl(undefined);
      return;
    }
    let cancelled = false;
    let created: string | undefined;
    void session
      .assetStore()
      .get(id)
      .then((bytes) => {
        if (cancelled || bytes === undefined) return;
        created = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setUrl(created);
      });
    return () => {
      cancelled = true;
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [session, id, mime]);
  return url;
}
