import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { requireSupabase } from "@/lib/supabase/client";
import { logDiagnostic } from "@/lib/utils";
import type { SubscriptionPlan, SubscriptionRequest, SupportChannel } from "@/services/subscriptions/types";
import { formatMinorUnits } from "@/services/subscriptions/money";
import { supportRepository } from "@/services/support/repository";
import type { CallerDetails } from "@/types/user";

import { SupportChat } from "./SupportChat";
import { SupportIdentifyForm } from "./SupportIdentifyForm";
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
  const [authChecked, setAuthChecked] = useState(supportRepository.mode !== "supabase");
  const [magicLinkEmail, setMagicLinkEmail] = useState("");
  const [supportCustomer, setSupportCustomer] = useState({ email: caller.email, name: caller.fullName });
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
      setSupportCustomer({ email, name });
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
    if (!plan || request || confirming.current) return;

    // Open the destination synchronously from the customer's click so browsers
    // do not treat the later, request-backed navigation as an unsolicited popup.
    const whatsappWindow = channel === "whatsapp" ? window.open("about:blank", "_blank") : null;
    if (whatsappWindow) whatsappWindow.opener = null;
    confirming.current = true;
    try {
      const created = await onConfirmSubscription(channel, supportCustomer.email);
      if (!created) {
        whatsappWindow?.close();
        return;
      }

      await resolveConversation({
        email: supportCustomer.email,
        name: supportCustomer.name,
        subject: `${created.planNameSnapshot} access â€” ${created.reference}`,
        subscriptionRequestId: created.id,
      }).catch((error: unknown) => logDiagnostic("support-link-request", error));
      state.reload();

      if (channel === "whatsapp") {
        const message = t("support.whatsappRequest", {
          plan: created.planNameSnapshot,
          host: profileName,
          price: formatMinorUnits(created.amountMinorUnits, created.currencyCode),
          minutes: String(plan.sessionDurationMinutes),
          features: plan.features.map((feature) => `- ${feature}`).join("\n"),
          reference: created.reference,
        });
        const link = whatsappLinkFor(created, message);
        if (link && whatsappWindow) whatsappWindow.location.href = link;
        else if (link) window.open(link, "_blank", "noopener");
        else whatsappWindow?.close();
        onClose();
      }
    } catch (error) {
      logDiagnostic("support-subscription-confirm", error);
      whatsappWindow?.close();
    } finally {
      confirming.current = false;
    }
  }, [
    channel,
    onClose,
    onConfirmSubscription,
    plan,
    request,
    state.reload,
    supportCustomer.email,
    supportCustomer.name,
    t,
    whatsappLinkFor,
  ]);

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

  /**
   * The caller already gave their email to join the call, so asking for it again
   * would be asking twice for the same thing. The form is only for somebody who
   * arrived without one.
   */
  useEffect(() => {
    if (conversationId || busy || failed || caller.email.trim().length === 0) return;
    if (supportRepository.mode !== "supabase") {
      setAuthChecked(true);
      open(caller.email, caller.fullName);
      return;
    }

    let cancelled = false;
    const client = requireSupabase();
    const openForVerifiedEmail = (email?: string) => {
      if (cancelled) return;
      setAuthChecked(true);
      if (email?.toLowerCase() === caller.email.trim().toLowerCase()) {
        open(caller.email, caller.fullName);
      }
    };
    void client.auth.getUser().then(({ data, error }) => {
      if (error) logDiagnostic("support-auth", error);
      openForVerifiedEmail(data.user?.email);
    });
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN") window.setTimeout(() => openForVerifiedEmail(session?.user.email), 0);
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [busy, caller.email, caller.fullName, conversationId, failed, open]);

  const identify = async (email: string, name: string) => {
    if (supportRepository.mode !== "supabase") {
      open(email, name);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      window.localStorage.setItem(`callastar-support-name:${email.toLowerCase()}`, name);
      const { error } = await requireSupabase().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/support` },
      });
      if (error) throw error;
      setMagicLinkEmail(email);
    } catch (error) {
      logDiagnostic("support-email-link", error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

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
          onPaymentMethodSubmitted={channel === "in_app" ? confirmSubscription : undefined}
          onContinueToWhatsapp={channel === "whatsapp" ? () => void confirmSubscription() : undefined}
        />
      ) : (
        <div className="support-overlay-panel">
          <button type="button" className="support-overlay-close" onClick={onClose} aria-label="Close support">
            <Icon name="close" className="size-5" />
          </button>

          {!authChecked && <p className="chat-note">{t("common.loading")}</p>}

          {failed && (
            <p className="cs-error" role="alert">
              We could not send the sign-in link or open your conversation.
              {whatsappNumber ? " You can also reach support on WhatsApp." : ""}
            </p>
          )}

          {magicLinkEmail && (
            <p className="cs-note" role="status">{t("support.accessLinkSent", { email: magicLinkEmail })}</p>
          )}

          {authChecked && (
            <SupportIdentifyForm
              initialEmail={caller.email}
              initialName={caller.fullName}
              busy={busy}
              secureEmailAccess={supportRepository.mode === "supabase"}
              onSubmit={({ email, name }) => void identify(email, name)}
              onCancel={onClose}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default SupportOverlay;
