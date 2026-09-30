import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { formatDateTime, copyText, logDiagnostic } from "@/lib/utils";
import { accessRepository } from "@/services/access/repository";
import { formatAccessId, maskAccessId } from "@/services/access/accessCode";
import type { SubscriptionAccessId } from "@/services/access/types";
import { notifyAdmin } from "@/services/notifications/repository";
import type { HostProfile } from "@/services/admin/types";
import type { SubscriptionPlan, SubscriptionPlanId } from "@/services/subscriptions/types";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { usePlans } from "../hooks/useCrmData";
import { formatUsdCents } from "./subscriptionInsights";

/**
 * Admin → Profile → Subscription Access.
 *
 * Plans are GLOBAL — this does not price anything per host. What it does is
 * issue a credential for THIS host under one of those plans, which is what an
 * operator needs after confirming somebody's payment.
 *
 * The generated code exists in one place and one moment: the panel below the
 * plan, right after it is created. It is never stored, so it cannot be shown
 * again; on a later visit only the last four characters remain.
 */
export function SubscriptionAccessCard({ profile }: { profile: HostProfile }) {
  const toast = useToast();
  const { data: plans, loading } = usePlans();
  const [issued, setIssued] = useState<SubscriptionAccessId[]>([]);
  /** Plaintext codes from THIS visit only. Never read back from storage. */
  const [freshCodes, setFreshCodes] = useState<Record<string, string>>({});
  const [busyPlan, setBusyPlan] = useState<SubscriptionPlanId | null>(null);
  const [revoking, setRevoking] = useState<SubscriptionAccessId | null>(null);

  const reload = useCallback(() => {
    void accessRepository
      .listProfileAccessIds(profile.id)
      .then(setIssued)
      .catch((error: unknown) => logDiagnostic("access-history", error));
  }, [profile.id]);

  useEffect(reload, [reload]);

  const generate = async (plan: SubscriptionPlan) => {
    setBusyPlan(plan.id);
    try {
      const { record, code } = await accessRepository.generateAccessId({
        profileId: profile.id,
        planId: plan.id,
      });

      setFreshCodes((current) => ({ ...current, [record.id]: code }));
      setIssued((current) => [record, ...current]);
      notifyAdmin({
        type: "subscription_requested",
        title: `${plan.displayName} access ID generated for ${profile.displayName}`,
        body: `Give the ID to the customer once their payment is confirmed.`,
        entityKind: "subscription_request",
        entityId: record.id,
      });
      toast.success(`${plan.displayName} access ID generated.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not generate an access ID.");
    } finally {
      setBusyPlan(null);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    try {
      await accessRepository.revokeAccessId(revoking.id);
      toast.success("Access ID revoked.");
      setRevoking(null);
      reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke that access ID.");
    }
  };

  const copy = async (code: string) => {
    const copied = await copyText(code);
    if (copied) toast.success("Access ID copied.");
    else toast.error("Could not copy the access ID.");
  };

  const share = async (code: string, planName: string) => {
    const text = `Your CallaStar ${planName} access ID for ${profile.displayName}: ${code}`;
    // Web Share where the platform has it; the clipboard everywhere else.
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "CallaStar access ID", text });
        return;
      } catch (error) {
        // A cancelled share is not a failure worth reporting.
        logDiagnostic("access-share", error);
        return;
      }
    }
    await copy(code);
  };

  const planName = (id: SubscriptionPlanId) => plans.find((plan) => plan.id === id)?.displayName ?? id;

  return (
    <section className="admin-card">
      <div className="admin-card-heading">
        <h2>Subscription Access</h2>
      </div>
      <p className="admin-hint">Generate an access ID after confirming a user&apos;s payment.</p>

      {loading ? (
        <p className="admin-hint">Loading plans…</p>
      ) : (
        <ul className="access-plan-list">
          {plans.map((plan) => {
            const fresh = issued.find((record) => freshCodes[record.id] && record.planId === plan.id);
            const code = fresh ? freshCodes[fresh.id] : null;

            return (
              <li key={plan.id} className={`access-plan ${plan.isMostPopular ? "is-popular" : ""}`.trim()}>
                <div className="access-plan-row">
                  <div className="access-plan-text">
                    <span className="access-plan-name">
                      {plan.displayName}
                      {plan.isMostPopular && (
                        <span className="access-plan-badge">
                          <Icon name="star" className="size-4" />
                          Most Popular
                        </span>
                      )}
                    </span>
                    {/* Read from the stored plan, never written into this file. */}
                    <span className="access-plan-meta">
                      {formatUsdCents(plan.priceUsdCents)} USD · Up to {plan.sessionDurationMinutes} minutes per
                      supported session
                    </span>
                  </div>

                  <button
                    type="button"
                    className={`admin-button ${plan.isMostPopular ? "admin-button-primary" : "admin-button-secondary"}`}
                    disabled={busyPlan !== null}
                    onClick={() => void generate(plan)}
                  >
                    {busyPlan === plan.id ? "Generating…" : "Generate Access ID"}
                  </button>
                </div>

                {code && fresh && (
                  <div className="access-plan-generated">
                    <div className="access-generated-head">
                      <span>Generated Subscription ID</span>
                      <small>{formatDateTime(fresh.createdAt)}</small>
                    </div>
                    <div className="access-generated-code">
                      <code>{formatAccessId(code)}</code>
                      <div className="access-generated-actions">
                        <button type="button" onClick={() => void copy(code)}>
                          <Icon name="copy" className="size-4" />
                          Copy
                        </button>
                        <span aria-hidden="true" />
                        <button type="button" onClick={() => void share(code, plan.displayName)}>
                          <Icon name="download" className="size-4" />
                          Share
                        </button>
                      </div>
                    </div>
                    <p className="admin-note">
                      Provide this Subscription ID to the user after their access has been confirmed. It is shown once
                      and cannot be recovered — generate another if it is lost.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="cs-note admin-access-note">
        <span className="cs-note-icon">
          <Icon name="info" className="size-6" />
        </span>
        <span>
          <strong className="cs-note-title">How access IDs are used</strong>
          Generated access IDs let a paid user start a new call session with this host. They work for this host and
          this plan only.
        </span>
      </div>

      {issued.length > 0 && (
        <>
          <h3 className="admin-card-label admin-card-label-sub">Issued access IDs</h3>
          <ul className="access-history">
            {issued.map((record) => (
              <li key={record.id}>
                <span className="access-history-main">
                  <strong>{planName(record.planId)}</strong>
                  {/* Only the last four were ever stored. */}
                  <code>{maskAccessId(record.codeLast4)}</code>
                  <small>
                    {formatDateTime(record.createdAt)}
                    {record.customerEmailNormalized ? ` · ${record.customerEmailNormalized}` : ""}
                  </small>
                </span>
                <span className="access-history-side">
                  <span
                    className={`admin-badge ${record.status === "active" ? "admin-badge-ready" : "admin-badge-neutral"}`}
                  >
                    {record.status === "active" ? "Active" : "Revoked"}
                  </span>
                  {record.status === "active" && (
                    <button type="button" className="admin-button admin-button-ghost" onClick={() => setRevoking(record)}>
                      Revoke
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this access ID?"
        confirmLabel="Revoke access ID"
        destructive
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      >
        <p>
          The customer holding it will no longer be able to start calls with {profile.displayName}. It stays on the
          record as revoked, so you can see it was issued.
        </p>
      </ConfirmDialog>
    </section>
  );
}

export default SubscriptionAccessCard;
