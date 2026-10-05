import { useRef } from "react";

import { Icon } from "@/components/ui/Icon";
import type { HostProfile } from "@/services/admin/types";

import { REFERENCE_ANGLES } from "../../source/sourceTypes";
import {
  CAPABILITY_LABEL,
  describeAngle,
  describeGrade,
  describeHeadRoom,
  describeProgress,
  describeSourceWarning,
  progressFraction,
  type CapabilityLevel,
} from "../sourceCopy";
import type { SourceSelection } from "../useSourceSelection";

interface SourcePanelProps {
  source: SourceSelection;
  profile: HostProfile | null;
  /** Stored assets on this profile that could be used as a source. */
  storedOptions: { assetId: string; label: string }[];
  /** Every profile, so an ambiguous choice can be named rather than guessed. */
  profileChoices: HostProfile[];
}

/**
 * Choosing and preparing the source person.
 *
 * Mobile-first: the source preview is the largest thing on the screen, and the
 * controls stack beneath it. Deliberately not a media table — an admin grid
 * squeezed onto a phone is how this step becomes unusable on the device most
 * likely to be holding the photograph.
 */
export function SourcePanel({ source, profile, storedOptions, profileChoices }: SourcePanelProps) {
  const imageInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);
  const modelInput = useRef<HTMLInputElement | null>(null);

  const analyzing = source.stage === "analyzing";
  const fraction = progressFraction(source.progress);

  return (
    <section className="studio-card studio-source">
      <h2>Source</h2>

      {/* Whose source this is. Preselected when the Studio was opened from a
          profile, so nobody prepares a face for the wrong person. */}
      {profile && (
        <div className="studio-source-profile">
          <span className="studio-source-avatar" aria-hidden="true">
            {profile.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>{profile.displayName}</strong>
            <small>{profile.callId}</small>
          </span>
        </div>
      )}

      {/*
        * No profile resolved, and more than one to choose from.
        *
        * Refusing to guess: a source prepared for the wrong person is the worst
        * outcome available here, and it would be invisible until a caller saw
        * somebody else's face.
        */}
      {!profile && profileChoices.length > 1 && (
        <p className="studio-alert" role="status">
          <Icon name="info" className="size-4" />
          <span>
            Open Transformation Studio from a profile to prepare a source for it. There are{" "}
            {profileChoices.length} profiles, so this step will not choose one for you.
          </span>
        </p>
      )}

      {!profile && profileChoices.length === 0 && (
        <p className="studio-note">Create a profile first — a source is prepared for a specific profile.</p>
      )}

      {profile && source.stage === "empty" && (
        <>
          <div className="studio-source-actions">
            <button type="button" className="studio-control" onClick={() => imageInput.current?.click()}>
              <Icon name="image" className="size-5" />
              <span>Upload image</span>
            </button>
            <button type="button" className="studio-control" onClick={() => videoInput.current?.click()}>
              <Icon name="video" className="size-5" />
              <span>Upload video</span>
            </button>
            {/* Beside the other two, never instead of them. */}
            <button type="button" className="studio-control" onClick={() => modelInput.current?.click()}>
              <Icon name="bolt" className="size-5" />
              <span>Upload 3D model</span>
              <em className="studio-experimental">Experimental</em>
            </button>
          </div>

          {storedOptions.length > 0 && (
            <div className="studio-source-existing">
              <h3>Existing media</h3>
              {storedOptions.map((option) => (
                <button
                  key={option.assetId}
                  type="button"
                  className="studio-control"
                  onClick={() => void source.selectStoredAsset(option.assetId, option.label)}
                >
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          )}

          <ul className="studio-source-tips">
            <li>Face clearly visible</li>
            <li>Shoulders visible</li>
            <li>Good lighting</li>
            <li>Limited motion blur</li>
          </ul>
        </>
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="admin-visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void source.selectFile(file);
          event.target.value = "";
        }}
      />
      <input
        ref={videoInput}
        type="file"
        accept="video/mp4,video/webm"
        className="admin-visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void source.selectFile(file);
          event.target.value = "";
        }}
      />
      <input
        ref={modelInput}
        type="file"
        accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
        className="admin-visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void source.selectFile(file);
          event.target.value = "";
        }}
      />

      {source.asset && (
        <p className="studio-source-file">
          <strong>{source.asset.fileName}</strong>
          <small>
            {source.asset.kind === "image" ? "Image" : source.asset.kind === "video" ? "Video" : "3D model"}
          </small>
        </p>
      )}

      {source.stage === "selected" && (
        <>
          {/*
            * Confirmed per source, and reset whenever one is chosen. A
            * confirmation that survived a source change would mean the operator
            * confirmed permission for a file they had not seen.
            */}
          <label className="studio-switch studio-consent">
            <input
              type="checkbox"
              checked={source.consentGiven}
              onChange={(event) => {
                source.setConsent(event.target.checked);
                if (event.target.checked) source.analyze(true);
              }}
            />
            <span>I confirm I have permission to use this source.</span>
          </label>

          <p className="studio-note">Analysis starts automatically after you confirm you have permission to use this source.</p>
          <button type="button" className="studio-control" onClick={source.clear}>
            <span>Change source</span>
          </button>
        </>
      )}

      {analyzing && (
        <>
          <p className="studio-source-progress" role="status">
            {describeProgress(source.progress)}
          </p>
          {/* A determinate bar only where there is something real to count. */}
          {fraction !== null ? (
            <div
              className="studio-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
            >
              <span style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          ) : (
            <div className="studio-progress is-indeterminate" aria-hidden="true">
              <span />
            </div>
          )}
          <button type="button" className="studio-control" onClick={source.cancel}>
            <span>Cancel</span>
          </button>
        </>
      )}

      {source.stage === "failed" && (
        <div className="studio-calibration-failed">
          <p className="studio-calibration-reason" role="alert">
            <strong>{source.message}</strong>
            {source.failure === "no-face" && (
              <span>Choose an image where the face is visible and well lit.</span>
            )}
          </p>
          <button type="button" className="studio-control" onClick={source.clear}>
            <span>Choose another source</span>
          </button>
        </div>
      )}

      {source.stage === "ready" && source.profile && (
        <SourceResults source={source} />
      )}

      {/* The model's own capabilities are reported by `AvatarPanel`; this is only
          the way back to choosing a different source. */}
      {source.stage === "ready" && !source.profile && source.avatar && (
        <button type="button" className="studio-control" onClick={source.clear}>
          <Icon name="rotate" className="size-5" />
          <span>Change source</span>
        </button>
      )}
    </section>
  );
}

function SourceResults({ source }: { source: SourceSelection }) {
  const profile = source.profile!;
  const grade = describeGrade(profile.quality.grade);
  const capabilities = profile.quality.capabilities;

  const level = (value: boolean): CapabilityLevel => (value ? "ready" : "unavailable");
  const headRoom = describeHeadRoom(profile.movementEnvelope.yawLeft, profile.movementEnvelope.yawRight);
  const upperBody: CapabilityLevel = capabilities.upperBody
    ? profile.quality.warnings.includes("shoulders-cropped")
      ? "limited"
      : "ready"
    : "unavailable";

  const covered = new Set(profile.referenceFrames.map((frame) => frame.angle));

  return (
    <div className="studio-source-results">
      <p className={`studio-quality is-${profile.quality.grade}`}>
        <Icon name="check" className="size-4" />
        <strong>{grade.label}</strong>
        <span>{grade.detail}</span>
      </p>

      <dl className="studio-source-capabilities">
        <div>
          <dt>Face</dt>
          <dd data-level={level(capabilities.face)}>{CAPABILITY_LABEL[level(capabilities.face)]}</dd>
        </div>
        <div>
          <dt>Expressions</dt>
          <dd data-level={level(capabilities.expressions)}>
            {CAPABILITY_LABEL[level(capabilities.expressions)]}
          </dd>
        </div>
        <div>
          <dt>Head movement</dt>
          <dd data-level={headRoom}>{CAPABILITY_LABEL[headRoom]}</dd>
        </div>
        <div>
          <dt>Upper body</dt>
          <dd data-level={upperBody}>{CAPABILITY_LABEL[upperBody]}</dd>
        </div>
      </dl>

      {profile.sourceKind === "video" && (
        <div className="studio-source-angles">
          <h3>Reference angles</h3>
          {/* Only the angles the source actually contains are ticked. A missing
              one stays missing rather than being filled with the nearest frame. */}
          <ul>
            {REFERENCE_ANGLES.map((angle) => (
              <li key={angle} data-present={covered.has(angle)}>
                <span>{describeAngle(angle)}</span>
                <span aria-hidden="true">{covered.has(angle) ? "✓" : "—"}</span>
                <span className="admin-visually-hidden">
                  {covered.has(angle) ? "available" : "not available"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {profile.quality.warnings.length > 0 && (
        <ul className="studio-warnings">
          {profile.quality.warnings.map((warning) => (
            <li key={warning}>{describeSourceWarning(warning)}</li>
          ))}
        </ul>
      )}

      <button type="button" className="studio-control" onClick={source.clear}>
        <Icon name="rotate" className="size-5" />
        <span>Change source</span>
      </button>
    </div>
  );
}

export default SourcePanel;
