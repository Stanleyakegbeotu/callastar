import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { logDiagnostic } from "@/lib/utils";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import type { SubscriptionPlanId, SupportPriority } from "@/services/subscriptions/types";

import { useToast } from "../components/ToastProvider";
import { usePlan } from "../hooks/useCrmData";
import { AdminPageHeader } from "../layout/AdminPageHeader";

interface FormState {
  displayName: string;
  /** Whole dollars in the field; cents in storage. */
  priceUsd: string;
  sessionDurationMinutes: string;
  supportPriority: SupportPriority;
  description: string;
  features: string;
  isActive: boolean;
  isMostPopular: boolean;
}

/**
 * Editing one global plan.
 *
 * The plan id is never editable: historical requests reference it, and renaming
 * "Premium" must not break what somebody already paid for. Prices are entered in
 * dollars and stored in cents, so money never passes through a float.
 */
export function EditPlanPage() {
  const { planId } = useParams<{ planId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: plan, loading, error } = usePlan(planId as SubscriptionPlanId | undefined);
  const [form, setForm] = useState<FormState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!plan) return;
    setForm({
      displayName: plan.displayName,
      priceUsd: String(plan.priceUsdCents / 100),
      sessionDurationMinutes: String(plan.sessionDurationMinutes),
      supportPriority: plan.supportPriority,
      description: plan.description,
      features: plan.features.join("\n"),
      isActive: plan.isActive,
      isMostPopular: plan.isMostPopular,
    });
  }, [plan]);

  if (loading) return <p className="admin-hint">Loading plan…</p>;
  if (error) {
    return (
      <p className="admin-error-banner" role="alert">
        {error}
      </p>
    );
  }
  if (!plan || !form) {
    return (
      <>
        <AdminPageHeader title="Plan not found" description="That plan does not exist." />
        <Link className="admin-button admin-button-primary" to="/admin/subscriptions/plans">
          Back to plans
        </Link>
      </>
    );
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm({ ...form, [key]: value });
    if (problem) setProblem(null);
  };

  const save = async () => {
    const name = form.displayName.trim();
    if (name.length < 2) {
      setProblem("Give the plan a name.");
      return;
    }

    const price = Number(form.priceUsd);
    if (!Number.isFinite(price) || price < 0) {
      setProblem("Enter the price in US dollars, for example 39.");
      return;
    }

    const minutes = Number(form.sessionDurationMinutes);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      setProblem("Enter the session length in whole minutes.");
      return;
    }

    setSaving(true);
    try {
      await subscriptionRepository.updatePlan(plan.id, {
        displayName: name,
        // Rounded at the boundary, so a stray fraction of a cent cannot be stored.
        priceUsdCents: Math.round(price * 100),
        sessionDurationMinutes: minutes,
        supportPriority: form.supportPriority,
        description: form.description.trim(),
        features: form.features
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        isActive: form.isActive,
        isMostPopular: form.isMostPopular,
      });
      toast.success(`${name} updated.`);
      navigate("/admin/subscriptions/plans");
    } catch (cause) {
      logDiagnostic("plan-save", cause);
      toast.error("That plan could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <AdminPageHeader
        title={`Edit ${plan.displayName}`}
        description="Changes apply to every profile. Requests already made keep the price they were quoted."
        eyebrow={
          <Link className="admin-link" to="/admin/subscriptions/plans">
            Access plans
          </Link>
        }
      />

      <section className="admin-card">
        <form
          className="admin-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="admin-field">
            <label htmlFor="plan-name">Plan name</label>
            <input
              id="plan-name"
              className="admin-input"
              value={form.displayName}
              onChange={(event) => update("displayName", event.target.value)}
            />
          </div>

          <div className="admin-field">
            <label htmlFor="plan-price">Price (USD)</label>
            <input
              id="plan-price"
              className="admin-input"
              type="number"
              min="0"
              step="1"
              value={form.priceUsd}
              onChange={(event) => update("priceUsd", event.target.value)}
            />
            <p className="admin-note">Prices are shown in US dollars in every language.</p>
          </div>

          <div className="admin-field">
            <label htmlFor="plan-minutes">Session length (minutes)</label>
            <input
              id="plan-minutes"
              className="admin-input"
              type="number"
              min="1"
              step="1"
              value={form.sessionDurationMinutes}
              onChange={(event) => update("sessionDurationMinutes", event.target.value)}
            />
          </div>

          <div className="admin-field">
            <label htmlFor="plan-priority">Support priority</label>
            <select
              id="plan-priority"
              className="admin-input admin-select"
              value={form.supportPriority}
              onChange={(event) => update("supportPriority", event.target.value as SupportPriority)}
            >
              <option value="standard">Standard</option>
              <option value="priority">Priority</option>
              <option value="highest">Highest</option>
            </select>
          </div>

          <div className="admin-field">
            <label htmlFor="plan-description">Description</label>
            <input
              id="plan-description"
              className="admin-input"
              value={form.description}
              onChange={(event) => update("description", event.target.value)}
            />
          </div>

          <div className="admin-field">
            <label htmlFor="plan-features">Features</label>
            <textarea
              id="plan-features"
              className="admin-input admin-textarea"
              rows={5}
              value={form.features}
              onChange={(event) => update("features", event.target.value)}
            />
            <p className="admin-note">One feature per line, in the order customers should read them.</p>
          </div>

          <fieldset className="admin-fieldset">
            <legend>Visibility</legend>
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) => update("isActive", event.target.checked)}
              />
              <span>Offer this plan to customers</span>
            </label>
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={form.isMostPopular}
                onChange={(event) => update("isMostPopular", event.target.checked)}
              />
              {/* At most one plan carries the badge; the repository clears it
                  from the others rather than trusting this screen to. */}
              <span>Show as Most Popular</span>
            </label>
          </fieldset>

          {problem && (
            <p className="admin-field-error" role="alert">
              {problem}
            </p>
          )}

          <div className="admin-form-actions">
            <button type="submit" className="admin-button admin-button-primary" disabled={saving}>
              {saving ? "Saving…" : "Save plan"}
            </button>
            <Link className="admin-button admin-button-secondary" to="/admin/subscriptions/plans">
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </>
  );
}

export default EditPlanPage;
