import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { logDiagnostic } from "@/lib/utils";
import type { SubscriptionPlan, SubscriptionRequest, SupportChannel } from "@/services/subscriptions/types";
import { supportRepository } from "@/services/support/repository";
import type { CallerDetails } from "@/types/user";
import { readSupportCustomerIdentity, setSupportCustomerIdentity } from "@/services/support/customerIdentity";

import { SupportChat } from "./SupportChat";
import { useSupportConversation } from "./hooks/useSupportConversation";
import { resolveConversation } from "./supportEntry";
import { announcePackageChange } from "./supportAutomation";

interface SupportOverlayProps {
  caller: CallerDetails;
  sessionId: string;
  /** The payment this thread is about, when support was opened to pay. */
  request: SubscriptionRequest | null;
  plan: SubscriptionPlan | null;
  availablePlans: SubscriptionPlan[];
  profileId: string;
  profileName: string;
  channel: SupportChannel;
  whatsappNumber: string | null;
  whatsappLinkFor: (request: SubscriptionRequest, message?: string) => string | null;
  onConfirmSubscription: (channel: SupportChannel, email: string) => Promise<SubscriptionRequest | null>;
  onSelectPackage: (plan: SubscriptionPlan) => Promise<void>;
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
export function SupportOverlay({
  caller,
  sessionId,
  request,
  plan,
  availablePlans,
  profileId,
  profileName,
  channel,
  whatsappNumber,
  whatsappLinkFor,
  onConfirmSubscription,
  onSelectPackage,
  onClose,
}: SupportOverlayProps) {
  const { t } = useTranslation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const savedIdentity = readSupportCustomerIdentity();
  const supportCustomer = {
    email: caller.email.trim() || savedIdentity.email,
    name: caller.fullName.trim() || savedIdentity.name,
    phone: caller.phone.trim() || savedIdentity.phone,
    normalizedEmail: (caller.email.trim() || savedIdentity.email).toLowerCase(),
    guestSessionId: savedIdentity.guestSessionId,
  };
  setSupportCustomerIdentity(supportCustomer);
  supportRepository.setCustomerIdentity?.(supportCustomer);
  const confirming = useRef(false);
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
        .then(async (conversation) => {
          const conversationPatch = {
            ...(plan ? {
              checkoutDraft: {
                ...(conversation.checkoutDraft ?? {}),
                sessionId,
                profileId,
                profileName,
                planId: plan.id,
                planName: plan.displayName,
                description: plan.description,
                features: plan.features,
                priceMinorUnits: plan.priceMinorUnits,
                currencyCode: plan.currencyCode,
                sortOrder: plan.sortOrder,
                sessionDurationMinutes: plan.sessionDurationMinutes,
                channel,
                entryIntent: channel,
                checkoutIntentId: conversation.checkoutDraft?.planId === plan.id
                  ? conversation.checkoutDraft.checkoutIntentId ?? `${conversation.id}:${plan.id}`
                  : crypto.randomUUID(),
                conversationMode: "payment" as const,
                subscriptionFollowupStatus: conversation.checkoutDraft?.planId === plan.id
                  ? conversation.checkoutDraft.subscriptionFollowupStatus ?? "awaiting_decision"
                  : "awaiting_decision" as const,
                paymentDecision: conversation.checkoutDraft?.planId === plan.id
                  ? conversation.checkoutDraft.paymentDecision ?? null : null,
                selectedPaymentMethod: conversation.checkoutDraft?.planId === plan.id
                  ? conversation.checkoutDraft.selectedPaymentMethod ?? null : null,
              },
            } : {}),
          };
          if (Object.keys(conversationPatch).length > 0) {
            await supportRepository.updateConversation(conversation.id, {
              ...conversationPatch,
            });
          }
          setConversationId(conversation.id);
        })
        .catch((error: unknown) => {
          logDiagnostic("support-open", error);
          // Failure has to be retryable, so the guard is released here rather
          // than held for the life of the overlay.
          opening.current = false;
          setFailed(true);
        })
        .finally(() => setBusy(false));
    },
    [channel, plan, profileId, profileName, request],
  );

  const confirmSubscription = useCallback(async () => {
    if (!plan || confirming.current) return;
    confirming.current = true;
    try {
      const created = request ?? await onConfirmSubscription(channel, supportCustomer.email);
      if (!created) return;
      if (conversationId) await supportRepository.updateConversation(conversationId, { subscriptionRequestId: created.id });
      state.reload();
    } catch (error) {
      logDiagnostic("support-subscription-confirm", error);
    } finally {
      confirming.current = false;
    }
  }, [channel, conversationId, onConfirmSubscription, plan, request, state.reload, supportCustomer.email]);

  const continueWhatsapp = useCallback(async () => {
    const method = state.conversation?.checkoutDraft?.selectedPaymentMethod;
    if (!method || !plan || !whatsappNumber) return;
    const target = window.open("about:blank", "_blank", "noopener");
    try {
      const created = request ?? await onConfirmSubscription("whatsapp", supportCustomer.email);
      const firstName = supportCustomer.name.trim().split(/\s+/)[0] || "a CallaStar customer";
      const link = created && whatsappLinkFor(created, `Hello, I'm ${firstName}. I selected ${method.replace(/_/g, " ")} for the ${plan.displayName} plan and would like to continue my payment.`);
      if (link && target) target.location.href = link;
      else if (link) window.open(link, "_blank", "noopener");
      else target?.close();
      if (created && conversationId) await supportRepository.updateConversation(conversationId, { subscriptionRequestId: created.id });
    } catch (error) {
      target?.close();
      logDiagnostic("support-continue-whatsapp", error);
    }
  }, [conversationId, onConfirmSubscription, plan, request, state.conversation?.checkoutDraft?.selectedPaymentMethod, supportCustomer.email, supportCustomer.name, whatsappLinkFor, whatsappNumber]);

  const continueInApp = useCallback(async () => {
    const conversation = state.conversation;
    if (!conversation?.checkoutDraft) return;
    await supportRepository.updateConversation(conversation.id, { checkoutDraft: { ...conversation.checkoutDraft, handoffChoice: "in_app" } });
    state.reload();
  }, [state.conversation, state.reload]);
  const selectPackage = useCallback(async (planId: SubscriptionPlan["id"]) => {
    const selected = availablePlans.find((candidate) => candidate.id === planId);
    if (!selected) return;
    await onSelectPackage(selected);
    const conversation = state.conversation;
    if (!conversation) return;
    const checkoutDraft = conversation.checkoutDraft ?? {
      sessionId,
      profileId,
      profileName,
      planId: selected.id,
      planName: selected.displayName,
      priceMinorUnits: selected.priceMinorUnits,
      currencyCode: selected.currencyCode,
      sortOrder: selected.sortOrder,
      sessionDurationMinutes: selected.sessionDurationMinutes,
      channel,
      checkoutIntentId: crypto.randomUUID(),
      conversationMode: "payment",
    };
    const updated = await supportRepository.updateConversation(conversation.id, {
      subscriptionRequestId: null,
      checkoutDraft: {
        ...checkoutDraft,
        profileId,
        profileName,
        planId: selected.id,
        planName: selected.displayName,
        description: selected.description,
        features: selected.features,
        priceMinorUnits: selected.priceMinorUnits,
        currencyCode: selected.currencyCode,
        sortOrder: selected.sortOrder,
        sessionDurationMinutes: selected.sessionDurationMinutes,
        channel,
        entryIntent: channel,
        checkoutIntentId: crypto.randomUUID(),
        conversationMode: "payment",
        subscriptionFollowupStatus: "awaiting_decision",
        paymentDecision: null,
        selectedPaymentMethod: null,
      },
    });
    if (!updated) throw new Error("The selected package could not be saved.");
    await announcePackageChange(conversation.id, selected);
    state.reload();
  }, [availablePlans, channel, onSelectPackage, profileId, profileName, sessionId, state.conversation, state.reload]);

  useEffect(() => {
    if (conversationId || busy || failed) return;
    open(supportCustomer.email, supportCustomer.name);
  }, [busy, conversationId, failed, open, supportCustomer.email, supportCustomer.name]);
  return (
    <div className="support-overlay" role="dialog" aria-modal="true" aria-label={t("support.supportName")}>
      {conversationId ? (
        <SupportChat
          state={state}
          viewer="customer"
          title={t("support.supportName")}
          subtitle={request ? `Reference ${request.reference}` : "Usually replies within a few minutes"}
          onBack={onClose}
          backLabel={t("support.closeSupport")}
          packagePlan={plan ?? undefined}
          packageOptions={availablePlans}
          onSelectPackage={
            !request || request.status !== "confirmed"
              ? selectPackage
              : undefined
          }
          onPaymentMethodSubmitted={confirmSubscription}
          onContinueToWhatsapp={whatsappNumber ? () => void continueWhatsapp() : undefined}
          onContinueInApp={() => void continueInApp()}
        />
      ) : (
        <div className="support-overlay-panel">
          <button type="button" className="support-overlay-close" onClick={onClose} aria-label="Close support">
            <Icon name="close" className="size-5" />
          </button>
          {failed && (
            <p className="cs-error" role="alert">
              We could not open your conversation. Please retry.
              {whatsappNumber ? " You can also reach support on WhatsApp." : ""}
              <button type="button" onClick={() => { opening.current = false; setFailed(false); }}>Retry</button>
            </p>
          )}

          {busy && <p className="chat-note" role="status">Opening Customer Care…</p>}
        </div>
      )}
    </div>
  );
}

export default SupportOverlay;
