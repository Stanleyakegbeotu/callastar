import { useId, useState, type ChangeEvent } from "react";

import { CALL_SOURCE_RULES, MEDIA_LIMITS } from "@/lib/config";
import { formatFileSize } from "@/lib/utils";
import { validateCallSourceVideo } from "@/services/admin/mediaFiles";

interface VideoUploadProps {
  file: File | null;
  previewUrl: string | null;
  onSelect: (file: File | null) => void;
  label?: string;
  disabled?: boolean;
}

/**
 * Remote call video picker.
 *
 * One video per profile, so this is a single slot rather than a library. The
 * preview uses native controls on purpose: this is an administrative review of
 * a file, where scrubbing and volume are exactly what is wanted. The live call
 * surface never shows controls.
 */
export function VideoUpload({ file, previewUrl, onSelect, label, disabled = false }: VideoUploadProps) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!selected) {
      onSelect(null);
      return;
    }

    // Async: the shape can only be known once the browser has read the header.
    setChecking(true);
    const check = await validateCallSourceVideo(selected).finally(() => setChecking(false));
    if (!check.ok) {
      setError(check.message);
      onSelect(null);
      return;
    }

    setError(null);
    onSelect(selected);
  };

  return (
    <div className="admin-upload admin-upload-video">
      {previewUrl ? (
        <video className="admin-video-preview" src={previewUrl} controls playsInline preload="metadata" />
      ) : (
        <div className="admin-video-placeholder" aria-hidden="true">
          No video selected
        </div>
      )}

      <div className="admin-upload-body">
        <div className="admin-upload-actions">
          <label className={`admin-button admin-button-secondary ${disabled ? "is-disabled" : ""}`} htmlFor={inputId}>
            {file || previewUrl ? "Choose a different video" : (label ?? "Upload video")}
          </label>
          <input
            id={inputId}
            className="admin-file-input"
            type="file"
            accept={MEDIA_LIMITS.REMOTE_VIDEO_MIME_TYPES.join(",")}
            onChange={(event) => void handleChange(event)}
            disabled={disabled || checking}
            // Names the requirement for the field itself, so the rule reaches a
            // screen reader before a file is chosen rather than only on rejection.
            aria-describedby={`${inputId}-rule`}
            aria-invalid={error !== null}
          />
          {file && (
            <button type="button" className="admin-button admin-button-ghost" onClick={() => onSelect(null)}>
              Clear
            </button>
          )}
        </div>

        {file && (
          <p className="admin-hint">
            {file.name} · {formatFileSize(file.size)}
          </p>
        )}
        <p className="admin-hint" id={`${inputId}-rule`}>
          <strong>Portrait 9:16 required.</strong> Upload a portrait video designed for CallaStar mobile video
          calls — {CALL_SOURCE_RULES.recommendedWidth}×{CALL_SOURCE_RULES.recommendedHeight} is ideal. MP4 or
          WebM, up to {formatFileSize(MEDIA_LIMITS.MAX_REMOTE_VIDEO_BYTES)}.
        </p>
        {checking && (
          <p className="admin-hint" role="status">
            Checking the video…
          </p>
        )}
        {error && (
          <p className="admin-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export default VideoUpload;
