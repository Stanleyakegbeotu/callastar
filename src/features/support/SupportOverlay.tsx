import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { logDiagnostic } from "@/lib/utils";
import type { SubscriptionRequest } from "@/services/subscriptions/types";
import type { CallerDetails } from "@/types/user";

import { SupportChat } from "./SupportChat";
import { SupportIdentifyForm } from "./SupportIdentifyForm";
import { useSupportConversation } from "./hooks/useSupportConversation";
import { resolveConversation } from "./supportEntry";

interface SupportOverlayProps {
  caller: CallerDetails;
  /** The payment this thread is about, when support was opened to pay. */
  request: SubscriptionRequest | null;
  whatsappNumber: string | null;
  onClose: () => void;
}

/**
 * Customer care over whatever is already on screen.
 *
 * An overlay rather than a route on purpose: the subscription flow behind it —
 * the plan that was chosen, the request that was created, the reference the
 * customer is about to quote — is state, and navigating away would throw it
 * away. Support is something you open and close, not somewhere you go.
 */
export function SupportOverlay({ caller, request, whatsappNumber, onClose }: SupportOverlayProps) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = useSupportConversation(conversationId, "customer");

  /**
   * Set synchronously, unlike `busy`. React batches state, so two effects in
   * the same tick would both see `busy === false` and both open a conversation.
   */
  const opening = useRef(false);

  const open = useCallback(
    (email: string, name: string) => {
      if (opening.current) return;
      opening.current = true;
      setBusy(true);
      setFailed(false);
      void resolveConversation({
        email,
        name,
        subject: request ? `${request.planNameSnapshot} access — ${request.reference}` : "CallaStar support",
        subscriptionRequestId: request?.id ?? null,
      })
        .then((conversation) => setConversationId(conversation.id))
        .catch((error: unknown) => {
          logDiagnostic("support-open", error);
          // Failure has to be retryable, so the guard is released here rather
          // than held for the life of the overlay.
          opening.current = false;
          setFailed(true);
        })
        .finally(() => setBusy(false));
    },
    [request],
  );

  /**
   * The caller already gave their email to join the call, so asking for it again
   * would be asking twice for the same thing. The form is only for somebody who
   * arrived without one.
   */
  useEffect(() => {
    if (conversationId || busy || failed) return;
    if (caller.email.trim().length === 0) return;
    open(caller.email, caller.fullName);
  }, [busy, caller.email, caller.fullName, conversationId, failed, open]);

  return (
    <div className="support-overlay" role="dialog" aria-modal="true" aria-label="CallaStar customer care">
      {conversationId ? (
        <SupportChat
          state={state}
          viewer="customer"
          title="CallaStar Support"
          subtitle={request ? `Reference ${request.reference}` : "Usually replies within a few minutes"}
          onBack={onClose}
          backLabel="Close support"
        />
      ) : (
        <div className="support-overlay-panel">
          <button type="button" className="support-overlay-close" onClick={onClose} aria-label="Close support">
            <Icon name="close" className="size-5" />
          </button>

          {failed && (
            <p className="cs-error" role="alert">
              We could not open your conversation.
              {whatsappNumber ? " You can also reach support on WhatsApp." : ""}
            </p>
          )}

          <SupportIdentifyForm
            initialEmail={caller.email}
            initialName={caller.fullName}
            busy={busy}
            onSubmit={({ email, name }) => open(email, name)}
            onCancel={onClose}
          />
        </div>
      )}
    </div>
  );
}

export default SupportOverlay;
