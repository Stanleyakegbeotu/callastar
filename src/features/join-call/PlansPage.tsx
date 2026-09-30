import { useCallback, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { useCallAccessGate } from "@/features/call-session/hooks/useCallAccessGate";
import { SubscriptionAccessScreen } from "@/features/call-session/subscription/SubscriptionAccessScreen";
import { SupportOverlay } from "@/features/support/SupportOverlay";
import { useWhatsappSupportNumber } from "@/features/support/hooks/useWhatsappSupportNumber";
import { notifyAdmin } from "@/services/notifications/repository";
import { createSessionId } from "@/services/callSession";
import type { SubscriptionRequest, SupportChannel } from "@/services/subscriptions/types";
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
  const { number: whatsappNumber } = useWhatsappSupportNumber();
  const openedFor = useRef<string | null>(null);
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

  const chooseChannel = useCallback(
    (channel: SupportChannel) => {
      void gate.startPayment(channel, session.caller.email).then((request) => {
        if (!request) return;
        if (channel === "in_app") {
          setSupportOpen(true);
          return;
        }
        const link = gate.whatsappLinkFor(request);
        if (!link || openedFor.current === request.id) return;
        openedFor.current = request.id;
        window.open(link, "_blank", "noopener");
      });
    },
    [gate, session.caller.email],
  );

  // Arriving here directly, with no host chosen, has nothing to price.
  if (!host) return <Navigate to="/connect" replace />;

  return (
    <>
      <SubscriptionAccessScreen
        gate={gate}
        host={host}
        onChooseChannel={chooseChannel}
        onOpenSupportChat={() => setSupportOpen(true)}
        // Paying here does not resume anything; the next call starts fresh.
        onStartNewCall={() => navigate(`/join/${session.type}`)}
        onGoHome={() => navigate("/")}
      />
      {supportOpen && (
        <SupportOverlay
          caller={session.caller}
          request={gate.request}
          whatsappNumber={gate.whatsappNumber}
          onClose={() => setSupportOpen(false)}
        />
      )}
    </>
  );
}

export default PlansPage;
