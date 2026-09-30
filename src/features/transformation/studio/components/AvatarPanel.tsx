import { EXPRESSION_KEYS, type ExpressionKey } from "../../engine/expressionMotion";
import type { AnalyzedAvatarModel } from "../../avatar/modelAnalyzer";
import type { AvatarWarning } from "../../avatar/avatarTypes";
import { formatFileSize } from "@/lib/utils";

interface AvatarPanelProps {
  model: AnalyzedAvatarModel;
  /** Development rig sliders. Null hides the panel entirely. */
  manual: {
    enabled: boolean;
    values: Record<ExpressionKey, number>;
    onToggle: (enabled: boolean) => void;
    onChange: (key: ExpressionKey, value: number) => void;
  } | null;
}

/**
 * What an uploaded model can and cannot do.
 *
 * The point of this panel is honesty. A static model cannot blink, and telling an
 * operator otherwise sends them hunting a tracking fault that does not exist — so
 * every row below is derived from a morph or a bone that was actually found in
 * the file.
 */

const EXPRESSION_LABEL: Record<ExpressionKey, string> = {
  blinkLeft: "Blink left",
  blinkRight: "Blink right",
  jawOpen: "Jaw open",
  smileLeft: "Smile left",
  smileRight: "Smile right",
  browInnerUp: "Brow inner",
  browOuterUpLeft: "Brow outer left",
  browOuterUpRight: "Brow outer right",
};

const WARNING_COPY: Record<AvatarWarning, string> = {
  "no-morph-targets":
    "Head motion is available, but this model does not contain compatible facial blendshapes.",
  "no-skeleton": "This model has no skeleton, so it can only be moved and rotated as a whole.",
  "no-head-bone": "No head bone was found, so the model rotates about its head geometry instead.",
  "partial-expressions": "Some expressions are unavailable because this model has no morph for them.",
  "heavy-for-mobile": "This model may be heavy for mobile real-time rendering.",
  "large-texture": "This model uses large textures, which can spike memory on a phone.",
  "no-mesh": "This model contains no geometry.",
  "has-animations": "This model contains its own animations. They are not played — your camera drives it.",
  "unusual-scale": "This model's units are unusual, so its scale has been normalised to fit the frame.",
};

export function AvatarPanel({ model, manual }: AvatarPanelProps) {
  const profile = model.profile;
  const capabilities = profile.capabilities;
  const mappedCount = EXPRESSION_KEYS.filter((key) => capabilities.expressions[key]).length;

  return (
    <section className="studio-card studio-avatar">
      <h2>3D Model · Experimental</h2>

      <p className="studio-source-file">
        <strong>{profile.fileName}</strong>
        <small>
          {profile.format.toUpperCase()} · {formatFileSize(profile.fileSizeBytes)} ·{" "}
          {profile.rigClass === "rigged-facial"
            ? "rigged with facial morphs"
            : profile.rigClass === "rigged-head"
              ? "rigged head"
              : "static model"}
        </small>
      </p>

      <dl className="studio-source-capabilities">
        {/* Head motion needs no rig, so it is always available. */}
        <div>
          <dt>Head tracking</dt>
          <dd data-level="ready">Ready</dd>
        </div>
        <div>
          <dt>Scale</dt>
          <dd data-level="ready">Ready</dd>
        </div>
        <div>
          <dt>Yaw / pitch / roll</dt>
          <dd data-level="ready">Ready</dd>
        </div>
        {EXPRESSION_KEYS.map((key) => (
          <div key={key}>
            <dt>{EXPRESSION_LABEL[key]}</dt>
            <dd data-level={capabilities.expressions[key] ? "ready" : "unavailable"}>
              {capabilities.expressions[key] ? "Ready" : "Unavailable"}
            </dd>
          </div>
        ))}
      </dl>

      {profile.warnings.length > 0 && (
        <ul className="studio-warnings">
          {profile.warnings.map((warning) => (
            <li key={warning}>{WARNING_COPY[warning]}</li>
          ))}
        </ul>
      )}

      <p className="studio-note">
        {profile.meshCount} mesh{profile.meshCount === 1 ? "" : "es"} ·{" "}
        {profile.vertexCount.toLocaleString()} vertices · {profile.morphTargetNames.length} morph targets,{" "}
        {mappedCount} mapped
        {profile.headBoneName ? ` · head bone ${profile.headBoneName}` : " · no head bone"}
        {profile.jawBoneName ? ` · jaw bone ${profile.jawBoneName}` : ""}
      </p>

      {/*
        * The manual rig panel, and the reason it exists.
        *
        * Driving each morph by hand through the SAME adapter the camera uses is
        * the fastest way to tell a model problem from a tracking problem. A
        * working slider beside a dead live input isolates the pipeline; both dead
        * isolates the rig.
        */}
      {manual && (
        <div className="studio-expression-manual">
          <label>
            <input
              type="checkbox"
              checked={manual.enabled}
              onChange={(event) => manual.onToggle(event.target.checked)}
            />{" "}
            Manual rig test
          </label>
          {manual.enabled && (
            <>
              <p className="studio-note">
                Drives the rig directly, through the same path the camera uses. Live tracking is ignored while
                this is on.
              </p>
              {EXPRESSION_KEYS.map((key) => (
                <label key={key} className="studio-rig-slider">
                  <span>
                    {EXPRESSION_LABEL[key]}
                    {!capabilities.expressions[key] && <em> — no morph</em>}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={manual.values[key]}
                    disabled={!capabilities.expressions[key]}
                    onChange={(event) => manual.onChange(key, Number(event.target.value))}
                  />
                  <span>{manual.values[key].toFixed(2)}</span>
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default AvatarPanel;
