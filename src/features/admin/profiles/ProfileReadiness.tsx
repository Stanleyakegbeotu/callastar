import { Icon } from "@/components/ui/Icon";
import { getProfileReadiness, getReadinessChecklist } from "@/services/admin/profileInsights";
import type { HostProfile } from "@/services/admin/types";

import { ReadinessBadge } from "../components/StatusBadge";

/**
 * What still has to happen before this profile can take a call. The checklist
 * and the badge both come from profileInsights, so they cannot disagree.
 */
export function ProfileReadiness({ profile }: { profile: HostProfile }) {
  const readiness = getProfileReadiness(profile);
  const checks = getReadinessChecklist(profile);

  return (
    <section className="admin-card">
      <div className="admin-card-heading">
        <h2 className="admin-card-label">Readiness</h2>
        <ReadinessBadge readiness={readiness} />
      </div>

      <ul className="admin-checklist">
        {checks.map((check) => (
          <li key={check.label} className={check.done ? "is-done" : ""}>
            <span className="admin-check-mark" aria-hidden="true">
              {check.done ? <Icon name="check" className="size-4" /> : <span className="admin-check-empty" />}
            </span>
            <span>
              <span className="admin-check-label">{check.label}</span>
              <span className="admin-visually-hidden">{check.done ? " complete" : " outstanding"}</span>
              {check.hint && <span className="admin-check-hint">{check.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default ProfileReadiness;
