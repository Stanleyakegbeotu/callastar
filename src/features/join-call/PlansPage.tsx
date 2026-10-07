import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { useCallAccessGate } from "@/features/call-session/hooks/useCallAccessGate";
import { SubscriptionAccessScreen } from "@/features/call-session/subscription/SubscriptionAccessScreen";
import { SupportOverlay } from "@/features/support/SupportOverlay";
import { useWhatsappSupportNumber } from "@/features/support/hooks/useWhatsappSupportNumber";
import { notifyAdmin } from "@/services/notifications/repository";
import { createSessionId } from "@/services/callSession";
import { logDiagnostic } from "@/lib/utils";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import { supportRepository } from "@/services/support/repository";
import type { SubscriptionPlan, SubscriptionRequest, SupportChannel } from "@/services/subscriptions/types";
import { useCallSession } from "@/state/CallSessionContext";

/**
 * `/plans` — choosing a plan without a call behind it.
 *
 * Reached by a returning caller whose preview for this host is already spent.
 * There is no call to end and none to resume, so this opens straight onto the
 * plans and otherwise runs the same flow as the post-call screen: same plans,
 * same payment channels, same support chat.
 *
 * A request made here still needs a session id to belong to. One is minted for
 * it — a subscription request that came from a browsing customer rather than
 * from a call that ended, which is a real distinction worth keeping in history.
 */
export function PlansPage() {
  const navigate = useNavigate();
  const { session } = useCallSession();
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportChannel, setSupportChannel] = useState<SupportChannel>("in_app");
  const [restoredRequest, setRestoredRequest] = useState<SubscriptionRequest | null>(null);
  const [restoring, setRestoring] = useState(true);
  const { number: whatsappNumber } = useWhatsappSupportNumber();
  // Stable for the life of this page, so a re-render cannot re-key the request.
  const [requestSessionId] = useState(() => createSessionId());

  const host = session.host;

  const onRequestCreated = useCallback((request: SubscriptionRequest) => {
    notifyAdmin({
      type: "subscription_requested",
      title: `${request.planNameSnapshot} access requested`,
      body: `${request.customerEmail} is waiting for ${request.reference} to be confirmed.`,
      entityKind: "subscription_request",
      entityId: request.id,
    });
  }, []);

  const gate = useCallAccessGate({
    sessionId: requestSessionId,
    profileId: host?.id ?? "",
    profileName: host?.displayName ?? "",
    customerEmail: session.caller.email,
    // Nothing to check and nothing to end: there is no call on this screen.
    armed: false,
    authorized: false,
    whatsappNumber,
    initialStatus: "selecting_plan",
    onAccessRequired: () => undefined,
    onRequestCreated,
  });

  useEffect(() => {
    if (gate.plansLoading) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!host || !session.caller.email.trim()) return;
        const requests = await subscriptionRepository.listRequests();
        const normalizedEmail = session.caller.email.trim().toLowerCase();
        const resumable = requests.find((request) =>
          request.profileId === host.id &&
          request.customerEmailNormalized === normalizedEmail &&
          ["awaiting_payment", "proof_submitted", "reviewing", "needs_attention"].includes(request.status),
        );
        const conversations = resumable ? [] : await supportRepository.listConversationsByEmail(session.caller.email);
        const draft = conversations.find((conversation) =>
          !conversation.subscriptionRequestId && conversation.checkoutDraft?.profileId === host.id,
        )?.checkoutDraft;
        const planId = resumable?.planId ?? draft?.planId;
        if (!planId || cancelled) return;
        const plan = gate.plans.find((candidate) => candidate.id === planId) ??
          await subscriptionRepository.getPlan(planId);
        if (!plan || cancelled) return;
        if (resumable) setRestoredRequest(resumable);
        setSupportChannel(resumable?.channel ?? draft?.channel ?? "in_app");
        gate.choosePlan(plan);
        setSupportOpen(true);
      } catch (error) {
        logDiagnostic("subscription-resume", error);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate.choosePlan, gate.plans, gate.plansLoading, host, session.caller.email]);

  const chooseChannel = useCallback(
    (channel: SupportChannel) => {
      setSupportChannel(channel);
      setSupportOpen(true);
    },
    [],
  );

  const openSupportChat = useCallback(() => {
    setSupportChannel("in_app");
    setSupportOpen(true);
  }, []);

  const confirmSubscription = useCallback(
    (channel: SupportChannel, email: string) => gate.startPayment(channel, email),
    [gate.startPayment],
  );

  const selectSupportPackage = useCallback(async (plan: SubscriptionPlan) => {
    const request = restoredRequest ?? gate.request;
    if (request && request.status !== "confirmed" && request.status !== "cancelled") {
      const cancelled = await subscriptionRepository.cancelRequest(request.id);
      if (!cancelled) throw new Error("The current payment request could not be cancelled.");
    }
    setRestoredRequest(null);
    gate.choosePlan(plan);
  }, [gate.choosePlan, gate.request, restoredRequest]);

  // Arriving here directly, with no host chosen, has nothing to price.
  if (!host) return <Navigate to="/connect" replace />;

  if (restoring) {
    return (
      <main className="access-screen" aria-live="polite">
        <p className="sheet-note">Resuming your CallaStar subscription…</p>
      </main>
    );
  }

  return (
    <>
      <SubscriptionAccessScreen
        gate={gate}
        host={host}
        onChooseChannel={chooseChannel}
        onOpenSupportChat={openSupportChat}
        // Paying here does not resume anything; the next call starts fresh.
        onStartNewCall={() => navigate(`/join/${session.type}`)}
        onGoHome={() => navigate("/")}
        welcomeBackName={session.caller.fullName}
      />
      {supportOpen && (
        <SupportOverlay
          caller={session.caller}
          sessionId={session.id}
          request={restoredRequest ?? gate.request}
          plan={gate.selectedPlan}
          availablePlans={gate.plans}
          profileId={host.id}
          profileName={host.displayName}
          channel={supportChannel}
          whatsappNumber={gate.whatsappNumber}
          whatsappLinkFor={gate.whatsappLinkFor}
          onConfirmSubscription={confirmSubscription}
          onSelectPackage={selectSupportPackage}
          onClose={() => setSupportOpen(false)}
        />
      )}
    </>
  );
}

export default PlansPage;
