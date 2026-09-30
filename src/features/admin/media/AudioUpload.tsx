import { useId, useState, type ChangeEvent } from "react";

import { MEDIA_LIMITS } from "@/lib/config";
import { formatFileSize } from "@/lib/utils";
import { validateRemoteAudioFile } from "@/services/admin/mediaFiles";

interface AudioUploadProps {
  file: File | null;
  previewUrl: string | null;
  onSelect: (file: File | null) => void;
  label?: string;
  disabled?: boolean;
}

/**
 * The voice a profile is heard with on an audio call.
 *
 * One file per profile, like the video, so this is a slot rather than a
 * library. Native controls on purpose: an operator reviewing an upload wants to
 * scrub and check the level. The call itself never shows controls.
 */
export function AudioUpload({ file, previewUrl, onSelect, label, disabled = false }: AudioUploadProps) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!selected) {
      onSelect(null);
      return;
    }

    const check = validateRemoteAudioFile(selected);
    if (!check.ok) {
      setError(check.message);
      onSelect(null);
      return;
    }

    setError(null);
    onSelect(selected);
  };

  return (
    <div className="admin-upload admin-upload-audio">
      {previewUrl ? (
        <audio className="admin-audio-preview" src={previewUrl} controls preload="metadata" />
      ) : (
        <div className="admin-audio-placeholder" aria-hidden="true">
          No audio selected
        </div>
      )}

      <div className="admin-upload-body">
        <div className="admin-upload-actions">
          <label className={`admin-button admin-button-secondary ${disabled ? "is-disabled" : ""}`} htmlFor={inputId}>
            {file || previewUrl ? "Choose a different audio file" : (label ?? "Upload audio")}
          </label>
          <input
            id={inputId}
            className="admin-file-input"
            type="file"
            accept={MEDIA_LIMITS.REMOTE_AUDIO_MIME_TYPES.join(",")}
            onChange={handleChange}
            disabled={disabled}
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
        <p className="admin-hint">
          MP3, AAC, WAV or OGG, up to {formatFileSize(MEDIA_LIMITS.MAX_REMOTE_AUDIO_BYTES)}. MP3 plays on every device.
        </p>
        {error && (
          <p className="admin-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export default AudioUpload;
