import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { AppHeader } from "@/components/layout/AppHeader";
import { logDiagnostic } from "@/lib/utils";
import { buildWhatsappLink } from "@/lib/phone";
import { requireSupabase } from "@/lib/supabase/client";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import type { SubscriptionPlan, SubscriptionRequest } from "@/services/subscriptions/types";
import { supportRepository } from "@/services/support/repository";

import { SupportChat } from "./SupportChat";
import { SupportIdentifyForm } from "./SupportIdentifyForm";
import { useSupportConversation } from "./hooks/useSupportConversation";
import { useWhatsappSupportNumber } from "./hooks/useWhatsappSupportNumber";
import { resolveConversation } from "./supportEntry";
import { announcePackageChange } from "./supportAutomation";

/**
 * `/support` — customer care reached on its own, rather than from a payment.
 *
 * Identifying by email leads to a real URL for the thread, so a customer can
 * come back to `/support/:id` directly. The email itself is never in the URL.
 */
export function SupportIdentifyPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkEmail, setMagicLinkEmail] = useState("");

  useEffect(() => {
    if (supportRepository.mode !== "supabase") return;
    let cancelled = false;
    const resumeSignedInCustomer = async (emailOverride?: string) => {
      const client = requireSupabase();
      const { data, error: authError } = await client.auth.getUser();
      if (authError || !data.user?.email || cancelled) return;
      const email = emailOverride ?? data.user.email;
      if (email.toLowerCase() !== data.user.email.toLowerCase()) return;
      let name = String(data.user.user_metadata?.full_name ?? "");
      try {
        name = window.localStorage.getItem(`callastar-support-name:${email.toLowerCase()}`) ?? name;
      } catch {
        // The verified email remains enough to reopen the history.
      }
      setBusy(true);
      void resolveConversation({ email, name, subject: "CallaStar support" })
        .then((conversation) => {
          if (!cancelled) navigate(`/support/${conversation.id}`, { replace: true });
        })
        .catch((cause: unknown) => {
          logDiagnostic("support-identify", cause);
          if (!cancelled) setError("We could not open your conversation. Please try again.");
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    };

    const client = requireSupabase();
    void resumeSignedInCustomer();
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user.email) {
        window.setTimeout(() => void resumeSignedInCustomer(session.user.email), 0);
      }
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [navigate]);

  const identify = async ({ email, name }: { email: string; name: string }) => {
    setBusy(true);
    setError(null);
    if (supportRepository.mode === "supabase") {
      try {
        window.localStorage.setItem(`callastar-support-name:${email.toLowerCase()}`, name);
        const { error: authError } = await requireSupabase().auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${window.location.origin}/support` },
        });
        if (authError) throw authError;
        setMagicLinkEmail(email);
      } catch (cause) {
        logDiagnostic("support-email-link", cause);
        setError("We could not send the sign-in link. Please try again.");
      } finally {
        setBusy(false);
      }
      return;
    }

    void resolveConversation({ email, name, subject: "CallaStar support" })
      .then((conversation) => navigate(`/support/${conversation.id}`, { replace: true }))
      .catch((cause: unknown) => {
        logDiagnostic("support-identify", cause);
        setError("We could not open your conversation. Please try again.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <main className="support-page">
      <AppHeader minimal />
      {error && (
        <p className="cs-error" role="alert">
          {error}
        </p>
      )}
      {magicLinkEmail && (
        <p className="cs-note" role="status">{t("support.accessLinkSent", { email: magicLinkEmail })}</p>
      )}
      <SupportIdentifyForm
        busy={busy}
        showLanguage
        secureEmailAccess={supportRepository.mode === "supabase"}
        onSubmit={(values) => void identify(values)}
        onCancel={() => navigate("/")}
      />
    </main>
  );
}

/** `/support/:conversationId` — one customer's thread. */
export function SupportThreadPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
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
    const target = window.open("about:blank", "_blank");
    if (target) target.opener = null;
    try {
      const request = await createResumedPaymentRequest();
      if (!request) {
        target?.close();
        return;
      }
      const link = buildWhatsappLink(
        whatsappNumber,
        `Hello CallaStar Support. I would like to continue my ${request.planNameSnapshot} subscription. Request reference: ${request.reference}.`,
      );
      if (link && target) target.location.href = link;
      else if (link) window.open(link, "_blank", "noopener");
      else target?.close();
    } catch (cause) {
      target?.close();
      logDiagnostic("support-continue-whatsapp", cause);
    }
  }, [createResumedPaymentRequest, whatsappNumber]);

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
        onContinueToWhatsapp={checkoutDraft?.channel === "whatsapp" && whatsappNumber ? () => void continueWhatsapp() : undefined}
      />
    </main>
  );
}

export default SupportIdentifyPage;
