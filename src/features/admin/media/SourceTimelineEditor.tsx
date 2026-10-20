import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceInterruption } from "@/services/media/interruptionTimeline";
import { formatTimelineTime, normalizeInterruptions } from "@/services/media/interruptionTimeline";
import { adminRepository } from "@/services/admin/repository";
import { useToast } from "../components/ToastProvider";

interface Props {
  assetId: string;
  url: string;
  durationSeconds: number;
  initialRanges: SourceInterruption[];
  onSaved: () => void;
  onClose: () => void;
}

const SAMPLE_COUNT = 16;
const SNAP_MS = 100;

export function SourceTimelineEditor({ assetId, url, durationSeconds, initialRanges, onSaved, onClose }: Props) {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const filmstripRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [durationMs, setDurationMs] = useState(Math.floor(durationSeconds * 1000));
  const [ranges, setRanges] = useState<SourceInterruption[]>(initialRanges);
  const [currentMs, setCurrentMs] = useState(0);
  const [draft, setDraft] = useState<{ startMs: number; endMs: number } | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [previewInterrupted, setPreviewInterrupted] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = useMemo(() => JSON.stringify(ranges) !== JSON.stringify(initialRanges), [initialRanges, ranges]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let frame = 0;
    const requestFrame = video.requestVideoFrameCallback?.bind(video);
    const tick = () => {
      if (cancelled) return;
      const hidden = ranges.some((range) => video.currentTime * 1000 >= range.startMs && video.currentTime * 1000 < range.endMs);
      video.muted = hidden;
      setPreviewInterrupted(hidden);
      if (requestFrame) frame = requestFrame(tick as VideoFrameRequestCallback);
      else frame = requestAnimationFrame(tick);
    };
    if (requestFrame) frame = requestFrame(tick as VideoFrameRequestCallback);
    else frame = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      video.cancelVideoFrameCallback?.(frame);
      cancelAnimationFrame(frame);
    };
  }, [ranges, url]);

  // A modest, fixed-size filmstrip keeps long source videos quick to open.
  useEffect(() => {
    const canvas = filmstripRef.current;
    if (!canvas || !url) return;
    let cancelled = false;
    const sample = document.createElement("video");
    sample.crossOrigin = "anonymous";
    sample.muted = true;
    sample.preload = "auto";
    sample.setAttribute("aria-hidden", "true");
    sample.style.cssText = "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.append(sample);
    sample.src = url;
    const waitForData = () => sample.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => finish(new Error("Video frame loading timed out.")), 8000);
      const ready = () => finish();
      const failed = () => finish(new Error("Video frame could not be decoded."));
      const finish = (error?: Error) => {
        window.clearTimeout(timeout);
        sample.removeEventListener("loadeddata", ready);
        sample.removeEventListener("error", failed);
        error ? reject(error) : resolve();
      };
      sample.addEventListener("loadeddata", ready, { once: true });
      sample.addEventListener("error", failed, { once: true });
    });
    const draw = async () => {
      try {
        if (sample.readyState < HTMLMediaElement.HAVE_METADATA) await new Promise<void>((resolve, reject) => {
          sample.addEventListener("loadedmetadata", () => resolve(), { once: true });
          sample.addEventListener("error", () => reject(new Error("preview unavailable")), { once: true });
        });
        // Safari may expose metadata before it decodes a drawable frame. Muted
        // playback prompts its decoder without involving the visible preview.
        await sample.play().catch(() => undefined);
        await waitForData();
        if (!sample.videoWidth || !sample.videoHeight) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        const cellWidth = canvas.width / SAMPLE_COUNT;
        const cellHeight = canvas.height;
        for (let index = 0; index < SAMPLE_COUNT; index++) {
          if (cancelled) return;
          const target = Math.min(sample.duration, (sample.duration * index) / SAMPLE_COUNT);
          if (Math.abs(sample.currentTime - target) > 0.025) {
            await new Promise<void>((resolve) => {
              const done = () => resolve();
              sample.addEventListener("seeked", done, { once: true });
              sample.currentTime = target;
            });
            await waitForData();
          }
          context.drawImage(sample, index * cellWidth, 0, cellWidth, cellHeight);
        }
      } catch { /* The playable video remains available even if thumbnails fail. */ }
    };
    void draw();
    return () => { cancelled = true; sample.pause(); sample.removeAttribute("src"); sample.load(); sample.remove(); };
  }, [url]);

  const close = () => {
    if (dirty && !window.confirm("Discard unsaved call timeline changes?")) return;
    onClose();
  };

  const seek = (value: number) => {
    const next = Math.max(0, Math.min(durationMs, Math.round(value / SNAP_MS) * SNAP_MS));
    setCurrentMs(next);
    if (videoRef.current) videoRef.current.currentTime = next / 1000;
  };

  const setStart = () => setDraft((current) => ({ startMs: current?.startMs ?? currentMs, endMs: Math.min(durationMs, Math.max(currentMs + SNAP_MS, current?.endMs ?? currentMs + 2000)) }));
  const setEnd = () => setDraft((current) => ({ startMs: current?.startMs ?? Math.max(0, currentMs - 2000), endMs: Math.max(current?.startMs ?? Math.max(0, currentMs - 2000) + SNAP_MS, currentMs) }));

  const addRange = () => {
    const startMs = Math.max(0, Math.min(durationMs - SNAP_MS, currentMs));
    const endMs = Math.min(durationMs, startMs + Math.max(1000, SNAP_MS));
    setDraft({ startMs, endMs });
    setEditingIndex(null);
  };

  const commitDraft = () => {
    if (!draft || draft.endMs <= draft.startMs || draft.endMs > durationMs) return;
    try {
      const next = [...ranges];
      if (editingIndex === null) next.push(draft);
      else next[editingIndex] = draft;
      setRanges(normalizeInterruptions(next, durationMs));
      setDraft(null);
      setEditingIndex(null);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Adjust the interruption range."); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const normalized = normalizeInterruptions(ranges, durationMs);
      await adminRepository.saveSourceInterruptions(assetId, normalized);
      toast.success("Call timeline saved.");
      onSaved();
      onClose();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Call timeline could not be saved."); }
    finally { setSaving(false); }
  };

  const scrubTimeline = (event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - bounds.left) / bounds.width) * durationMs);
  };

  return (
    <dialog ref={dialogRef} className="admin-dialog source-timeline-dialog" aria-labelledby="source-timeline-title" onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="admin-dialog-body source-timeline-body">
        <div className="source-timeline-heading">
          <div><p className="admin-eyebrow">Remote call video</p><h2 id="source-timeline-title">Configure Call Timeline</h2></div>
          <button type="button" className="admin-button admin-button-ghost" onClick={close}>Cancel / Back</button>
        </div>
        <div className="source-timeline-preview-wrap"><video ref={videoRef} className="source-timeline-preview" src={url} crossOrigin="anonymous" playsInline preload="metadata"
          onLoadedMetadata={(event) => { setDurationMs(Math.floor(event.currentTarget.duration * 1000)); setCurrentMs(0); event.currentTarget.currentTime = 0; }}
          onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
          {previewInterrupted && <div className="source-timeline-preview-overlay" role="status"><span className="source-interruption-spinner" aria-hidden="true" />Resuming call…</div>}
        </div>
        <div className="source-timeline-transport">
          <button type="button" className="admin-button admin-button-secondary" onClick={() => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play(); else video.pause(); }}>{playing ? "Pause preview" : "Play preview"}</button>
          <strong>{formatTimelineTime(currentMs)} <span aria-hidden="true">/</span> {formatTimelineTime(durationMs)}</strong>
          <label className="source-timeline-scrub">Seek video
            <input aria-label="Seek video" type="range" min={0} max={durationMs} step={SNAP_MS} value={Math.min(currentMs, durationMs)} onChange={(event) => seek(Number(event.currentTarget.value))} />
          </label>
        </div>
        <section className="source-timeline-workspace" aria-label="Video timeline">
          <div className="source-timeline-ruler"><span>00:00.000</span><span>{formatTimelineTime(durationMs / 4)}</span><span>{formatTimelineTime(durationMs / 2)}</span><span>{formatTimelineTime(durationMs * 3 / 4)}</span><span>{formatTimelineTime(durationMs)}</span></div>
          <div className="source-timeline-track" role="slider" aria-label="Video playhead" aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={Math.round(currentMs)} tabIndex={0}
            onClick={scrubTimeline} onKeyDown={(event) => { if (event.key === "ArrowRight") seek(currentMs + SNAP_MS); if (event.key === "ArrowLeft") seek(currentMs - SNAP_MS); }}>
            <canvas ref={filmstripRef} className="source-timeline-filmstrip" width={960} height={64} aria-label="Video thumbnail timeline" />
            {ranges.map((range, index) => <div key={`${range.startMs}-${index}`} className="source-timeline-range" style={{ left: `${range.startMs / durationMs * 100}%`, width: `${(range.endMs - range.startMs) / durationMs * 100}%` }} aria-label={`Interruption ${index + 1}`} />)}
            <div className="source-timeline-playhead" style={{ left: `${currentMs / durationMs * 100}%` }} aria-hidden="true" />
          </div>
        </section>
        {ranges.length === 0 ? <p className="admin-hint">No connection interruptions configured.</p> : <div className="source-timeline-list">
          {ranges.map((range, index) => <article className="source-timeline-item" key={`${range.startMs}-${index}`}>
            <div><strong>Connection Interruption {index + 1}</strong><p>Start {formatTimelineTime(range.startMs)} · End {formatTimelineTime(range.endMs)} · Duration {((range.endMs - range.startMs) / 1000).toFixed(1)} sec</p></div>
            <div className="admin-card-actions">
              <button type="button" className="admin-button admin-button-secondary" onClick={() => { setDraft({ startMs: range.startMs, endMs: range.endMs }); setEditingIndex(index); }}>Edit</button>
              <button type="button" className="admin-button admin-button-ghost" aria-label={`Delete interruption ${index + 1}`} onClick={() => setRanges((current) => current.filter((_, at) => at !== index))}>Delete</button>
            </div>
          </article>)}
        </div>}
        {draft && <fieldset className="source-timeline-markers"><legend>{editingIndex === null ? "New interruption" : `Edit interruption ${editingIndex + 1}`}</legend>
          <div className="source-timeline-marker-inputs">
            <label>Start: {formatTimelineTime(draft.startMs)}<input type="range" aria-label="Move interruption start" min={0} max={Math.max(0, draft.endMs - SNAP_MS)} step={SNAP_MS} value={draft.startMs} onChange={(event) => setDraft({ ...draft, startMs: Number(event.currentTarget.value) })} /></label>
            <label>End: {formatTimelineTime(draft.endMs)}<input type="range" aria-label="Move interruption end" min={Math.min(durationMs, draft.startMs + SNAP_MS)} max={durationMs} step={SNAP_MS} value={draft.endMs} onChange={(event) => setDraft({ ...draft, endMs: Number(event.currentTarget.value) })} /></label>
          </div>
          <div className="admin-card-actions"><button type="button" className="admin-button admin-button-secondary" onClick={setStart}>Set start at playhead</button><button type="button" className="admin-button admin-button-secondary" onClick={setEnd}>Set end at playhead</button><button type="button" className="admin-button admin-button-primary" disabled={draft.endMs <= draft.startMs} onClick={commitDraft}>{editingIndex === null ? "Add interruption" : "Apply edit"}</button></div>
        </fieldset>}
        <div className="admin-card-actions source-timeline-footer">
          <button type="button" className="admin-button admin-button-secondary" onClick={addRange}>Add Interruption</button>
          <span className="source-timeline-unsaved" aria-live="polite">{dirty ? "Unsaved changes" : "All changes saved"}</span>
          <button type="button" className="admin-button admin-button-primary" disabled={!dirty || saving || Boolean(draft)} onClick={() => void save()}>{saving ? "Saving…" : "Save timeline"}</button>
        </div>
      </div>
    </dialog>
  );
}
