import { useEffect, useMemo, useState, type FormEvent } from "react";

import { PROFILE_LIMITS } from "@/lib/config";
import { assertAudienceCount, parseAudienceCount } from "@/services/admin/profileEngagement";
import type { ProfileStatus } from "@/services/admin/types";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { useAssetUrl, useFilePreview } from "../hooks/useAdminData";
import { AudioUpload } from "../media/AudioUpload";
import { AvatarUpload } from "../media/AvatarUpload";
import { CoverUpload } from "../media/CoverUpload";
import { VideoUpload } from "../media/VideoUpload";

export interface ProfileFormValues {
  displayName: string;
  shortBio: string;
  status: ProfileStatus;
  baseFollowerCount: number;
  baseLikeCount: number;
  avatarFile: File | null;
  removeAvatar: boolean;
  coverFile: File | null;
  removeCover: boolean;
  remoteVideoFile: File | null;
  remoteAudioFile: File | null;
}

interface ProfileFormProps {
  mode: "create" | "edit";
  initialName?: string;
  initialBio?: string;
  initialStatus?: ProfileStatus;
  initialFollowerCount?: number;
  initialLikeCount?: number;
  /** Existing avatar on an edit; null while creating. */
  avatarAssetId?: string | null;
  coverAssetId?: string | null;
  submitting: boolean;
  progressLabel?: string;
  submitLabel: string;
  onSubmit: (values: ProfileFormValues) => void;
  onCancel: () => void;
}

interface FieldErrors {
  displayName?: string;
  shortBio?: string;
  baseFollowerCount?: string;
  baseLikeCount?: string;
}

/**
 * Create and edit share this form.
 *
 * Sections rather than one dense block: who the profile is, then the media that
 * represents them. The Call ID is never an input — it is issued on creation and
 * changed only by an explicit, confirmed action.
 */
export function ProfileForm({
  mode,
  initialName = "",
  initialBio = "",
  initialStatus = "active",
  initialFollowerCount = 0,
  initialLikeCount = 0,
  avatarAssetId = null,
  coverAssetId = null,
  submitting,
  progressLabel = "Saving…",
  submitLabel,
  onSubmit,
  onCancel,
}: ProfileFormProps) {
  const [displayName, setDisplayName] = useState(initialName);
  const [shortBio, setShortBio] = useState(initialBio);
  const [status, setStatus] = useState<ProfileStatus>(initialStatus);
  const [baseFollowerCount, setBaseFollowerCount] = useState(String(initialFollowerCount));
  const [baseLikeCount, setBaseLikeCount] = useState(String(initialLikeCount));
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [remoteVideoFile, setRemoteVideoFile] = useState<File | null>(null);
  const [remoteAudioFile, setRemoteAudioFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const storedAvatarUrl = useAssetUrl(removeAvatar ? null : avatarAssetId);
  const storedCoverUrl = useAssetUrl(removeCover ? null : coverAssetId);
  const chosenAvatarUrl = useFilePreview(avatarFile);
  const chosenCoverUrl = useFilePreview(coverFile);
  const chosenVideoUrl = useFilePreview(remoteVideoFile);
  const chosenAudioUrl = useFilePreview(remoteAudioFile);
  const avatarPreview = chosenAvatarUrl ?? storedAvatarUrl;

  const dirty = useMemo(
    () =>
      displayName !== initialName ||
      shortBio !== initialBio ||
      status !== initialStatus ||
      baseFollowerCount !== String(initialFollowerCount) ||
      baseLikeCount !== String(initialLikeCount) ||
      avatarFile !== null ||
      removeAvatar ||
      coverFile !== null ||
      removeCover ||
      remoteVideoFile !== null ||
      remoteAudioFile !== null,
    [
      avatarFile,
      displayName,
      initialBio,
      initialName,
      initialStatus,
      initialFollowerCount,
      initialLikeCount,
      baseFollowerCount,
      baseLikeCount,
      removeAvatar,
      coverFile,
      removeCover,
      remoteAudioFile,
      remoteVideoFile,
      shortBio,
      status,
    ],
  );

  // Catches a tab close or a reload with unsaved work; in-app navigation is
  // handled by the discard confirmation below.
  useEffect(() => {
    if (!dirty || submitting) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, submitting]);

  const validate = (): boolean => {
    const next: FieldErrors = {};
    const name = displayName.trim();

    if (name.length < PROFILE_LIMITS.NAME_MIN) next.displayName = "Enter a display name of at least 2 characters.";
    else if (name.length > PROFILE_LIMITS.NAME_MAX) next.displayName = `Keep the name under ${PROFILE_LIMITS.NAME_MAX} characters.`;
    if (shortBio.trim().length > PROFILE_LIMITS.BIO_MAX) next.shortBio = `Keep the bio under ${PROFILE_LIMITS.BIO_MAX} characters.`;

    try {
      parseAudienceCount(baseFollowerCount);
    } catch (cause) {
      next.baseFollowerCount = cause instanceof Error ? cause.message : "Enter a valid follower count.";
    }
    for (const [field, value] of [["baseLikeCount", baseLikeCount]] as const) {
      try {
        if (!value.trim()) throw new Error("Enter a count, or 0 if there are none.");
        assertAudienceCount(Number(value));
      } catch (cause) {
        next[field] = cause instanceof Error ? cause.message : "Enter a valid count.";
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !validate()) return;
    onSubmit({
      displayName: displayName.trim(),
      shortBio: shortBio.trim(),
      status,
      baseFollowerCount: parseAudienceCount(baseFollowerCount),
      baseLikeCount: Number(baseLikeCount),
      avatarFile,
      removeAvatar,
      coverFile,
      removeCover,
      remoteVideoFile,
      remoteAudioFile,
    });
  };

  const requestCancel = () => {
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  };

  return (
    <form className="admin-form" onSubmit={handleSubmit} noValidate>
      <section className="admin-card">
        <h2 className="admin-card-label">Profile details</h2>

        <AvatarUpload
          name={displayName}
          previewUrl={avatarPreview}
          onSelect={(file) => {
            setAvatarFile(file);
            if (file) setRemoveAvatar(false);
          }}
          onRemove={
            avatarPreview
              ? () => {
                  setAvatarFile(null);
                  setRemoveAvatar(Boolean(avatarAssetId));
                }
              : undefined
          }
          busy={submitting}
        />

        <div className="admin-field">
          <label>Cover photo</label>
          <CoverUpload
            previewUrl={chosenCoverUrl ?? storedCoverUrl}
            onSelect={(file) => {
              setCoverFile(file);
              if (file) setRemoveCover(false);
            }}
            onRemove={chosenCoverUrl || storedCoverUrl ? () => {
              setCoverFile(null);
              setRemoveCover(Boolean(coverAssetId));
            } : undefined}
            disabled={submitting}
          />
        </div>

        <div className="admin-field">
          <label htmlFor="profile-name">
            Display name <span aria-hidden="true">*</span>
          </label>
          <input
            id="profile-name"
            className="admin-input"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={PROFILE_LIMITS.NAME_MAX}
            aria-invalid={errors.displayName ? true : undefined}
            aria-describedby={errors.displayName ? "profile-name-error" : undefined}
            autoComplete="off"
            required
          />
          {errors.displayName && (
            <p className="admin-field-error" id="profile-name-error" role="alert">
              {errors.displayName}
            </p>
          )}
        </div>

        <div className="admin-field">
          <label htmlFor="profile-bio">Short bio</label>
          <textarea
            id="profile-bio"
            className="admin-input admin-textarea"
            value={shortBio}
            onChange={(event) => setShortBio(event.target.value)}
            maxLength={PROFILE_LIMITS.BIO_MAX}
            rows={3}
            aria-invalid={errors.shortBio ? true : undefined}
            aria-describedby="profile-bio-hint"
          />
          <p className="admin-hint" id="profile-bio-hint">
            Optional. {shortBio.trim().length}/{PROFILE_LIMITS.BIO_MAX} characters.
          </p>
          {errors.shortBio && (
            <p className="admin-field-error" role="alert">
              {errors.shortBio}
            </p>
          )}
        </div>

        <fieldset className="admin-field admin-fieldset">
          <legend>Status</legend>
          <div className="admin-radio-row">
            {(["active", "inactive"] as const).map((option) => (
              <label key={option} className={`admin-radio ${status === option ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="profile-status"
                  value={option}
                  checked={status === option}
                  onChange={() => setStatus(option)}
                />
                <span>{option === "active" ? "Active" : "Inactive"}</span>
              </label>
            ))}
          </div>
          <p className="admin-hint">Inactive profiles cannot be reached by their Call ID.</p>
        </fieldset>
      </section>

      <section className="admin-card">
        <h2 className="admin-card-label">Followers and likes</h2>
        <p className="admin-hint">
          Enter the host&apos;s existing counts. Follower counts accept values like 12k or 1.5M. New follows and likes collected in CallaStar are added automatically.
        </p>
        <div className="admin-audience-fields">
          {([
            { field: "baseFollowerCount", label: "Follower count", value: baseFollowerCount, setValue: setBaseFollowerCount },
            { field: "baseLikeCount", label: "Like count", value: baseLikeCount, setValue: setBaseLikeCount },
          ] as const).map(({ field, label, value, setValue }) => (
            <div className="admin-field" key={field}>
              <label htmlFor={`profile-${field}`}>{label}</label>
              <input id={`profile-${field}`} className="admin-input" type="text" inputMode={field === "baseFollowerCount" ? "decimal" : "numeric"}
                placeholder={field === "baseFollowerCount" ? "e.g. 12k or 1.5M" : "0"} value={value}
                onChange={(event) => setValue(event.target.value)} disabled={submitting}
                aria-invalid={errors[field] ? true : undefined}
                aria-describedby={errors[field] ? `profile-${field}-error` : undefined} />
              {errors[field] && <p className="admin-field-error" id={`profile-${field}-error`} role="alert">{errors[field]}</p>}
            </div>
          ))}
        </div>
      </section>

      {mode === "create" && (
        <section className="admin-card">
          <h2 className="admin-card-label">Remote call media</h2>
          <p className="admin-hint">This video will appear as the remote participant after a video call connects.</p>
          <VideoUpload file={remoteVideoFile} previewUrl={chosenVideoUrl} onSelect={setRemoteVideoFile} disabled={submitting} />

          <h3 className="admin-card-label admin-card-label-sub">Audio call voice</h3>
          <p className="admin-hint">
            Played on an audio call. Without one, an audio call falls back to the soundtrack of the video above.
          </p>
          <AudioUpload file={remoteAudioFile} previewUrl={chosenAudioUrl} onSelect={setRemoteAudioFile} disabled={submitting} />

          <p className="admin-note">A unique Call ID will be generated automatically after creation.</p>
        </section>
      )}

      <div className="admin-form-actions">
        <button type="button" className="admin-button admin-button-ghost" onClick={requestCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="admin-button admin-button-primary" disabled={submitting}>
          {submitting ? progressLabel : submitLabel}
        </button>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard changes?"
        confirmLabel="Discard"
        destructive
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onCancel();
        }}
      >
        <p>Your unsaved changes to this profile will be lost.</p>
      </ConfirmDialog>
    </form>
  );
}

export default ProfileForm;
