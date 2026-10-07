import { useId, useState, type ChangeEvent } from "react";

import { MEDIA_LIMITS } from "@/lib/config";
import { formatFileSize } from "@/lib/utils";
import { validateCoverFile } from "@/services/admin/mediaFiles";

interface CoverUploadProps {
  previewUrl: string | null;
  onSelect: (file: File | null) => void;
  onRemove?: () => void;
  disabled?: boolean;
}

export function CoverUpload({ previewUrl, onSelect, onRemove, disabled = false }: CoverUploadProps) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;

    const check = validateCoverFile(file);
    if (!check.ok) {
      setError(check.message);
      onSelect(null);
      return;
    }
    setError(null);
    onSelect(file);
  };

  return (
    <div className="admin-cover-upload">
      <div className="admin-cover-preview" aria-label={previewUrl ? "Cover photo preview" : "No cover photo selected"}>
        {previewUrl ? <img src={previewUrl} alt="" /> : <span>Cover photo preview</span>}
      </div>
      <div className="admin-upload-actions">
        <label className={`admin-button admin-button-secondary ${disabled ? "is-disabled" : ""}`} htmlFor={inputId}>
          {previewUrl ? "Change cover photo" : "Upload cover photo"}
        </label>
        <input
          id={inputId}
          className="admin-file-input"
          type="file"
          accept={MEDIA_LIMITS.COVER_MIME_TYPES.join(",")}
          onChange={handleChange}
          disabled={disabled}
        />
        {previewUrl && onRemove && (
          <button type="button" className="admin-button admin-button-ghost" onClick={onRemove} disabled={disabled}>
            Remove
          </button>
        )}
      </div>
      <p className="admin-hint">JPG, PNG or WebP, up to {formatFileSize(MEDIA_LIMITS.MAX_COVER_BYTES)}. Displayed above the host profile.</p>
      {error && <p className="admin-field-error" role="alert">{error}</p>}
    </div>
  );
}

export default CoverUpload;
