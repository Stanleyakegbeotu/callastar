import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatDateTime, formatDuration } from "@/lib/utils";
import { logDiagnostic } from "@/lib/utils";
import { callEvidenceRepository } from "@/services/evidence/repository";
import type { CallEvidence } from "@/services/evidence/types";
import { config } from "@/lib/config";
import { AdminPageHeader } from "../layout/AdminPageHeader";

export function CallEvidencePage() {
  const [params] = useSearchParams();
  const hostId = params.get("hostId") ?? undefined;
  const [rows, setRows] = useState<CallEvidence[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageNonce, setImageNonce] = useState(0);
  const thumbnailKeys = rows.filter((row) => row.status === "ready").map((row) => row.id).join("|");

  useEffect(() => {
    let cancelled = false;
    const load = (retrySync: boolean) => {
      setLoading(true);
      setError(null);
      void callEvidenceRepository.list(hostId, { retrySync }).then((data) => {
        if (!cancelled) setRows(data);
      }).catch((cause: unknown) => {
        logDiagnostic("CALL_EVIDENCE_ADMIN_QUERY_FAILED", cause);
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load call evidence.");
      }).finally(() => { if (!cancelled) setLoading(false); });
    };
    const refresh = () => load(false);
    load(true);
    window.addEventListener("callastar:call-evidence-updated", refresh);
    return () => { cancelled = true; window.removeEventListener("callastar:call-evidence-updated", refresh); };
  }, [hostId]);

  useEffect(() => {
    let cancelled = false;
    const owned: string[] = [];
    void Promise.all(rows.filter((row) => row.status === "ready" && !row.thumbnailUrl).map(async (row) => {
      try {
        const url = await callEvidenceRepository.imageUrl(row.id);
        owned.push(url);
        return [row.id, url] as const;
      } catch { return [row.id, null] as const; }
    })).then((pairs) => {
      if (cancelled) return;
      const urls = new Map(pairs);
      setRows((current) => current.map((row) => ({ ...row, thumbnailUrl: row.thumbnailUrl ?? urls.get(row.id) ?? null })));
    });
    return () => { cancelled = true; owned.forEach((url) => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); }); };
  }, [thumbnailKeys]);

  useEffect(() => {
    let cancelled = false;
    let ownedUrl: string | null = null;
    setUrl(null);
    setImageFailed(false);
    if (selected) void callEvidenceRepository.imageUrl(selected).then((next) => {
      if (cancelled) { if (next.startsWith("blob:")) URL.revokeObjectURL(next); return; }
      ownedUrl = next;
      setUrl(next);
    }).catch((cause: unknown) => { logDiagnostic("CALL_EVIDENCE_ADMIN_IMAGE_FAILED", cause); if (!cancelled) { setImageFailed(true); setError("Evidence image unavailable. Please retry."); } });
    return () => { cancelled = true; if (ownedUrl?.startsWith("blob:")) URL.revokeObjectURL(ownedUrl); };
  }, [selected, imageNonce]);

  const chosen = rows.find((row) => row.id === selected);
  return <>
    <AdminPageHeader title="Call evidence" description="One private snapshot from each video call that reached the active state." eyebrow={<Link className="admin-link" to={hostId ? `/admin/profiles/${hostId}` : "/admin/sessions"}>Back</Link>} actions={<button type="button" className="admin-button admin-button-secondary" onClick={() => window.dispatchEvent(new Event("callastar:call-evidence-updated"))}>Refresh</button>} />
    {config.callBackend !== "supabase" && <p className="admin-note">Call evidence is saved on the device that made the call. To see calls made on another device, connect the call backend to Supabase and deploy the call evidence migration and functions.</p>}
    {error && <p className="admin-error-banner" role="alert">{error}</p>}
    {loading ? <p className="admin-hint">Loading call evidence…</p> : rows.length === 0 ? <p className="admin-hint">No call evidence yet.</p> : <div className="evidence-layout">
      <div className="evidence-list">
        {rows.map((row) => <button type="button" className={`evidence-item ${selected === row.id ? "is-selected" : ""}`} key={row.id} onClick={() => setSelected(row.id)}>
          {row.thumbnailUrl && <img className="call-evidence-thumbnail" src={row.thumbnailUrl} alt="" aria-hidden="true" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
          <strong>{row.callerName || row.callerEmail}</strong>
          <span>{row.hostName} · {formatDateTime(row.capturedAt ?? row.createdAt)}</span>
          <small>{row.planType.replace("_", " ")} video · {row.durationSeconds === null ? "Duration pending" : formatDuration(row.durationSeconds)}</small>
          <small><b>{row.syncStatus === "local_only" ? "Local" : row.syncStatus === "sync_pending" ? "Pending Sync" : row.syncStatus === "sync_failed" ? "Sync Failed" : "Synced"}</b> · {row.status === "ready" ? row.callStatus : row.status.replace("_", " ")}</small>
        </button>)}
      </div>
      <section className="admin-card evidence-viewer" aria-label="Call evidence viewer">
        {chosen ? <>
          <h2>{chosen.callerName} with {chosen.hostName}</h2>
          <p className="admin-hint">{formatDateTime(chosen.capturedAt ?? chosen.createdAt)} · {chosen.durationSeconds === null ? "Duration pending" : formatDuration(chosen.durationSeconds)}</p>
          {imageFailed ? <p role="alert">Evidence image unavailable. <button className="admin-button admin-button-secondary" onClick={() => { setError(null); setImageNonce((n) => n + 1); }}>Retry</button></p>
            : chosen.status === "ready" && url ? <img className="call-evidence-image" src={url} onError={() => setImageFailed(true)} alt={`Call evidence for ${chosen.callerName} and ${chosen.hostName}`} /> : <p className="admin-hint">{chosen.status === "capture_failed" ? `Snapshot unavailable${chosen.failureReason ? `: ${chosen.failureReason}` : "."}` : chosen.status === "ready" ? "Preparing secure evidence image…" : "No snapshot is available yet."}</p>}
          <dl className="call-evidence-details">
            <div><dt>Plan</dt><dd>{chosen.packageName ?? (chosen.planType === "free_trial" ? "Free Trial" : chosen.planType.toUpperCase())}</dd></div>
            <div><dt>Call status</dt><dd>{chosen.callStatus}</dd></div>
            <div><dt>Call type</dt><dd>Video</dd></div>
            <div><dt>Answered</dt><dd>{chosen.answeredAt ? formatDateTime(chosen.answeredAt) : "—"}</dd></div>
            <div><dt>Ended</dt><dd>{chosen.endedAt ? formatDateTime(chosen.endedAt) : "In progress"}</dd></div>
            <div><dt>Duration</dt><dd>{chosen.durationSeconds === null ? "—" : formatDuration(chosen.durationSeconds)}</dd></div>
            <div><dt>End reason</dt><dd>{chosen.terminationReason ?? "—"}</dd></div>
            <div><dt>Sync</dt><dd>{chosen.syncStatus.replace("_", " ")}</dd></div>
            <div><dt>Session ID</dt><dd><code>{chosen.callSessionId}</code></dd></div>
          </dl>
          <p className="admin-hint">Evidence images are private. The viewer uses a temporary authorized URL.</p>
        </> : <p className="admin-hint">Select a call to view its evidence snapshot and session details.</p>}
      </section>
    </div>}
  </>;
}
