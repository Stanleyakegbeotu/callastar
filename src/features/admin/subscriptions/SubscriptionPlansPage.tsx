import { Link } from "react-router-dom";

import { formatDateTime } from "@/lib/utils";

import { usePlans } from "../hooks/useCrmData";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { formatUsdCents } from "./subscriptionInsights";

const PRIORITY_LABELS: Record<string, string> = {
  standard: "Standard support",
  priority: "Priority support",
  highest: "Highest priority support",
};

/**
 * Admin → Subscriptions → Plans.
 *
 * The three plans are global: every profile is sold on the same terms at the
 * same prices, so this is one list rather than a per-profile setting. Prices are
 * in USD everywhere, regardless of the language the app is being read in.
 */
export function SubscriptionPlansPage() {
  const { data: plans, loading, error } = usePlans();

  return (
    <>
      <AdminPageHeader
        title="Access plans"
        description="Global plans, prices and features. These apply to every CallaStar profile."
        eyebrow={
          <Link className="admin-link" to="/admin/subscriptions">
            Subscriptions
          </Link>
        }
      />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="admin-hint">Loading plans…</p>
      ) : (
        <div className="admin-plan-grid">
          {plans.map((plan) => (
            <section key={plan.id} className="admin-card admin-plan-card">
              <div className="admin-card-heading">
                <h2>{plan.displayName}</h2>
                {plan.isMostPopular && <span className="admin-badge admin-badge-live">Most Popular</span>}
                {!plan.isActive && <span className="admin-badge admin-badge-neutral">Hidden</span>}
              </div>

              <p className="admin-plan-price">
                {formatUsdCents(plan.priceUsdCents)}
                <small>USD</small>
              </p>

              <dl className="admin-meta-grid">
                <div>
                  <dt>Session length</dt>
                  <dd>{plan.sessionDurationMinutes} minutes</dd>
                </div>
                <div>
                  <dt>Support</dt>
                  <dd>{PRIORITY_LABELS[plan.supportPriority] ?? plan.supportPriority}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatDateTime(plan.updatedAt)}</dd>
                </div>
              </dl>

              <ul className="admin-plan-features">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>

              <div className="admin-card-actions">
                <Link className="admin-button admin-button-secondary" to={`/admin/subscriptions/plans/${plan.id}`}>
                  Edit plan
                </Link>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

export default SubscriptionPlansPage;
