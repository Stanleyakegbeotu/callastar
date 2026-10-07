import { productionDiagnostic } from "./productionDiagnostics";

export function claimChunkReload(storage: Pick<Storage, "getItem" | "setItem">, now = Date.now()): boolean {
  const key = "callastar:chunk-reload";
  try {
    const previous = Number(storage.getItem(key));
    if (previous && now - previous < 300_000) return false;
    storage.setItem(key, String(now));
    return true;
  } catch { return false; }
}
export function installChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    productionDiagnostic("CHUNK_LOAD_FAILED");
    if (navigator.onLine && claimChunkReload(sessionStorage)) {
      event.preventDefault();
      window.location.reload();
    }
  });
}
