import type { StudioStep } from "../studioSteps";

interface StudioStepRailProps {
  steps: StudioStep[];
}

/**
 * The six steps, including Save, which is not available yet.
 *
 * An unbuilt step is labelled as unbuilt rather than merely greyed out: a
 * disabled control invites clicking and then looks broken, whereas "Not built
 * yet" is simply true.
 */
export function StudioStepRail({ steps }: StudioStepRailProps) {
  return (
    <ol className="studio-steps" aria-label="Transformation Studio steps">
      {steps.map((step, index) => (
        <li
          key={step.id}
          className={`studio-step is-${step.status}`}
          aria-current={step.status === "current" ? "step" : undefined}
        >
          <span className="studio-step-index" aria-hidden="true">
            {index + 1}
          </span>
          <span className="studio-step-label">{step.label}</span>
          {step.status === "unbuilt" && (
            <span className="studio-step-note">
              Not built yet
              {step.note && <span className="admin-visually-hidden">. {step.note}</span>}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

export default StudioStepRail;
