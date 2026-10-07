import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { logDiagnostic } from "@/lib/utils";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import type { SubscriptionPlanId } from "@/services/subscriptions/types";
import { isCurrencyCode, majorAmountToMinorUnits, minorUnitsToMajorString } from "@/services/subscriptions/money";

import { useToast } from "../components/ToastProvider";
import { usePlan } from "../hooks/useCrmData";
import { AdminPageHeader } from "../layout/AdminPageHeader";

interface FormState {
  displayName: string;
  /** Whole currency units in the field; minor units in storage. */
  price: string;
  currencyCode: string;
  sortOrder: string;
  sessionDurationMinutes: string;
  description: string;
  features: string;
  isActive: boolean;
  isMostPopular: boolean;
}

/**
 * Editing one global plan.
 *
 * Plan ids stay stable after migration, while admins control the displayed name,
 * currency, price, benefits, visibility, and display order.
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
      price: minorUnitsToMajorString(plan.priceMinorUnits, plan.currencyCode),
      currencyCode: plan.currencyCode,
      sortOrder: String(plan.sortOrder),
      sessionDurationMinutes: String(plan.sessionDurationMinutes),
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

    const price = Number(form.price);
    if (!Number.isFinite(price) || price < 0) {
      setProblem("Enter a valid price in the selected currency.");
      return;
    }

    const currencyCode = form.currencyCode.trim().toUpperCase();
    if (!isCurrencyCode(currencyCode)) {
      setProblem("Enter a valid three-letter ISO currency code, such as USD.");
      return;
    }

    const sortOrder = Number(form.sortOrder);
    if (!Number.isInteger(sortOrder) || sortOrder < 1) {
      setProblem("Enter a display order of 1 or higher.");
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
        priceMinorUnits: majorAmountToMinorUnits(price, currencyCode),
        currencyCode,
        sortOrder,
        sessionDurationMinutes: minutes,
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
            <label htmlFor="plan-price">Price</label>
            <input
              id="plan-price"
              className="admin-input"
              type="number"
              min="0"
              step="any"
              value={form.price}
              onChange={(event) => update("price", event.target.value)}
            />
            <p className="admin-note">Enter the amount in the currency selected below.</p>
          </div>

          <div className="admin-field">
            <label htmlFor="plan-currency">Currency code</label>
            <input id="plan-currency" className="admin-input" maxLength={3} autoCapitalize="characters" value={form.currencyCode} onChange={(event) => update("currencyCode", event.target.value.toUpperCase())} />
          </div>

          <div className="admin-field">
            <label htmlFor="plan-order">Display order</label>
            <input id="plan-order" className="admin-input" type="number" min="1" step="1" value={form.sortOrder} onChange={(event) => update("sortOrder", event.target.value)} />
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
