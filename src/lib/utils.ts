/**
 * MM:SS, or H:MM:SS once a call passes an hour. Used by the call timer and by
 * every duration the dashboard shows, so the two always read the same.
 */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Clock time for a timeline entry, in the reader's own timezone. */
export function formatTimeOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * React Router's basename. Vite's `base` may be an absolute URL (Figma Make
 * sets FIGMA_PUBLIC_URL), and the router only understands a path.
 */
export function resolveRouterBasename(base: string = import.meta.env.BASE_URL): string {
  if (!base) return "/";
  if (/^https?:\/\//i.test(base)) {
    try {
      return new URL(base).pathname || "/";
    } catch {
      return "/";
    }
  }
  return base;
}

/** Dev-only diagnostics; keeps raw browser errors out of the UI and out of prod logs. */
export function logDiagnostic(scope: string, detail: unknown): void {
  if (import.meta.env.DEV) {
    console.warn(`[callastar:${scope}]`, detail);
  }
}

/** Human file size for the admin media UI: 24.8 MB, 512 KB, 900 bytes. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} bytes`;

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Short absolute date for record metadata: 26 Sep 2026, 14:05. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Deterministic initials for an avatar placeholder: first letter of the first
 * and last words, never generated imagery standing in for a real person.
 */
export function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/**
 * Copy text, with a fallback for browsers that refuse the async clipboard API
 * (older Safari, and any non-secure context). Returns whether it worked, so the
 * caller can tell the person the truth.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    logDiagnostic("clipboard", error);
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch (error) {
    logDiagnostic("clipboard-fallback", error);
    return false;
  }
}
