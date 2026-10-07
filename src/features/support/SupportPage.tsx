import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { AppHeader } from "@/components/layout/AppHeader";
import { logDiagnostic } from "@/lib/utils";
import { buildWhatsappLink } from "@/lib/phone";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import type { SubscriptionPlan, SubscriptionRequest } from "@/services/subscriptions/types";
import { supportRepository } from "@/services/support/repository";

import { SupportChat } from "./SupportChat";
import { useSupportConversation } from "./hooks/useSupportConversation";
import { useWhatsappSupportNumber } from "./hooks/useWhatsappSupportNumber";
import { resolveConversation } from "./supportEntry";
import { announcePackageChange } from "./supportAutomation";
import { readSupportCustomerIdentity } from "@/services/support/customerIdentity";

/**
 * `/support` — customer care reached on its own, rather than from a payment.
 *
 * Identifying by email leads to a real URL for the thread, so a customer can
 * come back to `/support/:id` directly. The email itself is never in the URL.
 */
export function SupportIdentifyPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const identity = readSupportCustomerIdentity();
    supportRepository.setCustomerIdentity?.(identity);
    void resolveConversation({ email: identity.email, name: identity.name, subject: "CallaStar support" })
      .then((conversation) => { if (!cancelled) navigate(`/support/${conversation.id}`, { replace: true }); })
      .catch((cause: unknown) => { logDiagnostic("support-identify", cause); if (!cancelled) setError("We could not open your conversation. Please retry."); });
    return () => {
      cancelled = true;
    };
  }, [attempt, navigate]);

  return (
    <main className="support-page">
      <AppHeader minimal />
      {error && (
        <div className="cs-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Retry</button>
          <button type="button" onClick={() => navigate("/")}>Back</button>
        </div>
      )}
      {!error && <p className="cs-note" role="status">Opening Customer Care…</p>}
    </main>
  );
}

/** `/support/:conversationId` — one customer's thread. */
export function SupportThreadPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const identity = readSupportCustomerIdentity();
  supportRepository.setCustomerIdentity?.(identity);
  const state = useSupportConversation(conversationId ?? null, "customer");
  const { number: whatsappNumber } = useWhatsappSupportNumber();
  const [resumePlan, setResumePlan] = useState<SubscriptionPlan | null>(null);
  const [resumeRequest, setResumeRequest] = useState<SubscriptionRequest | null>(null);
  const [availablePlans, setAvailablePlans] = useState<SubscriptionPlan[]>([]);
  const checkoutDraft = state.conversation?.checkoutDraft ?? null;
  const currentConversationId = state.conversation?.id;

  useEffect(() => {
    let cancelled = false;
    const requestId = state.conversation?.subscriptionRequestId;
    const planId = checkoutDraft?.planId;
    if (!currentConversationId) {
      setResumePlan(null);
      setResumeRequest(null);
      return;
    }
    void Promise.all([
      planId
        ? subscriptionRepository.getPlan(planId)
        : Promise.resolve(null),
      requestId
        ? subscriptionRepository.getRequest(requestId)
        : Promise.resolve(null),
      subscriptionRepository.listPlans(),
    ])
      .then(([plan, request, plans]) => {
        if (cancelled) return;
        setResumePlan(plan);
        setResumeRequest(request);
        setAvailablePlans(plans.filter((candidate) => candidate.isActive));
      })
      .catch((error: unknown) => logDiagnostic("support-resume-context", error));
    return () => {
      cancelled = true;
    };
  }, [checkoutDraft?.planId, currentConversationId, state.conversation?.subscriptionRequestId]);

  const createResumedPaymentRequest = useCallback(async () => {
    if (!currentConversationId) return null;
    const latest = await supportRepository.getConversation(currentConversationId);
    const draft = latest?.checkoutDraft;
    if (latest?.subscriptionRequestId) return subscriptionRepository.getRequest(latest.subscriptionRequestId);
    if (!latest || !draft?.sessionId) return null;
    const existing = (await subscriptionRepository.listSessionRequests(draft.sessionId)).find((candidate) =>
      candidate.planId === draft.planId &&
      candidate.customerEmailNormalized === latest.customerEmailNormalized &&
      candidate.status !== "cancelled",
    );
    const request = existing ?? await subscriptionRepository.createRequest({
      sessionId: draft.sessionId,
      profileId: draft.profileId,
      profileName: draft.profileName,
      customerEmail: latest.customerEmail,
      planId: draft.planId,
      planNameSnapshot: draft.planName,
      amountMinorUnits: draft.priceMinorUnits,
      currencyCode: draft.currencyCode,
      channel: draft.channel,
    });
    await supportRepository.updateConversation(currentConversationId, { subscriptionRequestId: request.id });
    setResumeRequest(request);
    state.reload();
    return request;
  }, [currentConversationId, state.reload]);

  const continueWhatsapp = useCallback(async () => {
    if (!whatsappNumber) return;
    const draft = state.conversation?.checkoutDraft;
    const method = draft?.selectedPaymentMethod ?? "payment method";
    const firstName = state.conversation?.customerName.trim().split(/\s+/)[0] || "a CallaStar customer";
    const planName = draft?.planName ?? resumePlan?.displayName ?? "CallaStar";
    const link = buildWhatsappLink(whatsappNumber,
      `Hello, I'm ${firstName}. I'm continuing my CallaStar payment for the ${planName} plan. Selected payment method: ${String(method).replace(/_/g, " ")}. I'd like to continue and finalize the payment here.`);
    if (!link) return;

    // Navigate in the tap itself. iOS Safari blocks a window opened after an
    // awaited request, which was the source of the blank WhatsApp tab.
    window.location.assign(link);
    void createResumedPaymentRequest().catch((cause: unknown) => logDiagnostic("support-continue-whatsapp", cause));
  }, [createResumedPaymentRequest, resumePlan?.displayName, state.conversation?.checkoutDraft, state.conversation?.customerName, whatsappNumber]);

  const continueInApp = useCallback(async () => {
    if (!currentConversationId || !checkoutDraft) return;
    await supportRepository.updateConversation(currentConversationId, { checkoutDraft: { ...checkoutDraft, handoffChoice: "in_app" } });
    state.reload();
  }, [checkoutDraft, currentConversationId, state.reload]);

  const selectPackage = useCallback(async (planId: SubscriptionPlan["id"]) => {
    const selected = availablePlans.find((candidate) => candidate.id === planId);
    if (!selected || !currentConversationId || !checkoutDraft) return;
    if (resumeRequest && resumeRequest.status !== "confirmed" && resumeRequest.status !== "cancelled") {
      const cancelled = await subscriptionRepository.cancelRequest(resumeRequest.id);
      if (!cancelled) throw new Error("The current payment request could not be cancelled.");
    }
    const updated = await supportRepository.updateConversation(currentConversationId, {
      subscriptionRequestId: null,
      checkoutDraft: {
        ...checkoutDraft,
        planId: selected.id,
        planName: selected.displayName,
        description: selected.description,
        features: selected.features,
        priceMinorUnits: selected.priceMinorUnits,
        currencyCode: selected.currencyCode,
        sortOrder: selected.sortOrder,
        sessionDurationMinutes: selected.sessionDurationMinutes,
        checkoutIntentId: crypto.randomUUID(),
        conversationMode: "payment",
        subscriptionFollowupStatus: "awaiting_decision",
        paymentDecision: null,
        selectedPaymentMethod: null,
      },
    });
    if (!updated) throw new Error("The selected package could not be saved.");
    await announcePackageChange(currentConversationId, selected);
    setResumeRequest(null);
    setResumePlan(selected);
    state.reload();
  }, [availablePlans, checkoutDraft, currentConversationId, resumeRequest, state.reload]);

  useEffect(() => {
    if (!currentConversationId || !checkoutDraft || checkoutDraft.subscriptionFollowupStatus) return;
    void supportRepository.updateConversation(currentConversationId, {
      checkoutDraft: { ...checkoutDraft, subscriptionFollowupStatus: "awaiting_decision" },
    })
      .then(() => state.reload())
      .catch((error: unknown) => logDiagnostic("support-subscription-resume", error));
  }, [checkoutDraft, currentConversationId, state.reload]);

  const packagePlan = checkoutDraft
    ? resumePlan ?? {
        id: checkoutDraft.planId,
        displayName: checkoutDraft.planName,
        priceMinorUnits: checkoutDraft.priceMinorUnits,
        currencyCode: checkoutDraft.currencyCode,
        sortOrder: checkoutDraft.sortOrder,
        sessionDurationMinutes: checkoutDraft.sessionDurationMinutes,
        description: checkoutDraft.description ?? "",
        features: checkoutDraft.features ?? [],
      }
    : undefined;

  // A missing or inaccessible thread must lead back to email identification.
  if (!state.loading && !state.conversation) {
    return (
      <main className="support-page">
        <AppHeader minimal />
        <div className="support-missing">
          <h1 className="cs-display">Conversation not found</h1>
          <p className="cs-lede">
            This support conversation is not available on this device. Enter your email address to find it again.
          </p>
          <button type="button" className="primary-button" onClick={() => navigate("/support", { replace: true })}>
            <span>Find my conversation</span>
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="support-page support-page-chat">
      <AppHeader minimal />
      <SupportChat
        state={state}
        viewer="customer"
        title="CallaStar Support"
        subtitle={state.conversation?.subject ?? "Customer care"}
        onBack={() => navigate("/")}
        backLabel="Back to CallaStar"
        packagePlan={packagePlan}
        packageOptions={availablePlans}
        onSelectPackage={
          !resumeRequest || resumeRequest.status !== "confirmed"
            ? selectPackage
            : undefined
        }
        onPaymentMethodSubmitted={async () => { await createResumedPaymentRequest(); }}
        onContinueToWhatsapp={whatsappNumber ? () => void continueWhatsapp() : undefined}
        onContinueInApp={() => void continueInApp()}
      />
    </main>
  );
}

export default SupportIdentifyPage;
