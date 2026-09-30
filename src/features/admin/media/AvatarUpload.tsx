import { useId, useState, type ChangeEvent } from "react";

import { MEDIA_LIMITS } from "@/lib/config";
import { formatFileSize, getInitials } from "@/lib/utils";
import { validateAvatarFile } from "@/services/admin/mediaFiles";

interface AvatarUploadProps {
  name: string;
  /** Existing avatar, or the preview of a file chosen but not yet saved. */
  previewUrl: string | null;
  onSelect: (file: File | null) => void;
  onRemove?: () => void;
  disabled?: boolean;
  busy?: boolean;
}

/**
 * Avatar picker with an immediate preview. The file is validated the moment it
 * is chosen, so a wrong format is refused before anyone presses Save.
 */
export function AvatarUpload({ name, previewUrl, onSelect, onRemove, disabled = false, busy = false }: AvatarUploadProps) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // Reset so choosing the same file twice still fires a change event.
    event.target.value = "";

    if (!file) {
      onSelect(null);
      return;
    }

    const check = validateAvatarFile(file);
    if (!check.ok) {
      setError(check.message);
      onSelect(null);
      return;
    }

    setError(null);
    onSelect(file);
  };

  return (
    <div className="admin-upload admin-upload-avatar">
      <span className="admin-avatar admin-avatar-lg">
        {previewUrl ? <img src={previewUrl} alt="" /> : <span aria-hidden="true">{getInitials(name || "?")}</span>}
      </span>

      <div className="admin-upload-body">
        <div className="admin-upload-actions">
          <label className={`admin-button admin-button-secondary ${disabled || busy ? "is-disabled" : ""}`} htmlFor={inputId}>
            {previewUrl ? "Change image" : "Upload image"}
          </label>
          <input
            id={inputId}
            className="admin-file-input"
            type="file"
            accept={MEDIA_LIMITS.AVATAR_MIME_TYPES.join(",")}
            onChange={handleChange}
            disabled={disabled || busy}
          />
          {previewUrl && onRemove && (
            <button type="button" className="admin-button admin-button-ghost" onClick={onRemove} disabled={busy}>
              Remove
            </button>
          )}
        </div>
        <p className="admin-hint">
          JPG, PNG or WebP, up to {formatFileSize(MEDIA_LIMITS.MAX_AVATAR_BYTES)}. Shown while a call connects.
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

export default AvatarUpload;
