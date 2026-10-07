import { requireSupabase } from "@/lib/supabase/client";
import { productionDiagnostic } from "@/lib/productionDiagnostics";
import { withDeadline } from "@/lib/withDeadline";
import { STORAGE_BUCKETS, CALL_MEDIA_TTL_SECONDS } from "../../../supabase/functions/_shared/storageContract";
import type { AssetKind } from "@/services/admin/types";
export { STORAGE_BUCKETS, CALL_MEDIA_TTL_SECONDS };

type ResolvedAsset = { url: string; expiresAt: number; hasAudio: boolean };
const cache = new Map<string, { expiresAt: number; pending: Promise<ResolvedAsset | null> }>();
let watching = false;
let generation = 0;
export function clearPrivateMediaCache(): void { generation++; cache.clear(); }

export async function resolveAdminMedia(reference: string, refresh = false): Promise<ResolvedAsset | null> {
  const client = requireSupabase();
  if (!watching) {
    client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "USER_UPDATED") clearPrivateMediaCache();
    });
    watching = true;
  }
  if (refresh) cache.delete(reference);
  const cached = cache.get(reference);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.pending;
  const version = generation;
  const expiresAt = Date.now() + CALL_MEDIA_TTL_SECONDS * 1000;
  const pending = (async () => {
    // host_assets.id is text; avatar/cover references are storage paths.
    const column = reference.includes("/") ? "storage_path" : "id";
    const { data: row, error } = await withDeadline(client.from("host_assets").select("kind,storage_path,has_audio").eq(column, reference).maybeSingle());
    if (error) { productionDiagnostic("HOST_MEDIA_QUERY_FAILED"); throw new Error("Unable to load media. Please retry."); }
    if (!row) return null;
    const bucket = STORAGE_BUCKETS[row.kind as AssetKind];
    if (!bucket) throw new Error("Unsupported media type.");
    const { data, error: signError } = await withDeadline(client.storage.from(bucket).createSignedUrl(row.storage_path, CALL_MEDIA_TTL_SECONDS));
    if (signError || !data?.signedUrl) { productionDiagnostic("SIGNED_URL_FAILED"); throw new Error("Unable to authorize media. Please retry."); }
    if (version !== generation) throw new Error("Admin session changed. Please retry.");
    return { url: data.signedUrl, expiresAt, hasAudio: row.has_audio ?? true };
  })();
  cache.set(reference, { expiresAt, pending });
  try { const resolved = await pending; if (!resolved && cache.get(reference)?.pending === pending) cache.delete(reference); return resolved; }
  catch (error) { if (cache.get(reference)?.pending === pending) cache.delete(reference); throw error; }
}
