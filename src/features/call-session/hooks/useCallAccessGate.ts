import { useCallback, useEffect, useRef, useState } from "react";

import { SUBSCRIPTION_TIMINGS } from "@/lib/config";
import { LOCAL_EVENT_CHANNEL } from "@/lib/localEvents";
import { buildWhatsappLink } from "@/lib/phone";
import { logDiagnostic } from "@/lib/utils";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import type { SubscriptionPlan, SubscriptionRequest, SupportChannel } from "@/services/subscriptions/types";
import { formatMinorUnits } from "@/services/subscriptions/money";

/**
 * Whether this call is allowed to keep going.
 *
 * Deliberately separate from the call lifecycle: the call is `active`
 * throughout `checking`, because the check must not interrupt a conversation
 * that is happening. The two statuses only ever line up like this:
 *
 *   checking   -> call active,  media playing, timer running
 *   granted    -> call active,  nothing on screen
 *   required   -> call ENDED,   media released, access screen shown
 *
 * `required` with a live call is not a state this hook can produce: the callback
 * that ends the call runs in the same step that sets it.
 */
export type CallAccessStatus =
  /** Media is playing and nothing has been checked yet. */
  | "previewing"
  /** Looking access up. The call carries on underneath. */
  | "checking"
  /** Access found. The call carries on, with nothing in the way. */
  | "granted"
  /** No access. The call has been ended; this is the post-call screen. */
  | "required"
  | "selecting_plan"
  | "payment_method"
  | "payment_pending"
  /** Support confirmed a payment. The next call can claim it. */
  | "confirmed";

export interface CallAccessGate {
  status: CallAccessStatus;
  /**
   * True once the checkpoint owns the screen. Only ever true after the call has
   * ended, so it never means "a sheet over a live call".
   */
  blocksCall: boolean;
  selectedPlan: SubscriptionPlan | null;
  request: SubscriptionRequest | null;
  plans: SubscriptionPlan[];
  plansLoading: boolean;
  /** Digits for `wa.me`, or null when no operator has configured a number. */
  whatsappNumber: string | null;
  openPlans: () => void;
  choosePlan: (plan: SubscriptionPlan) => void;
  backToPlans: () => void;
  startPayment: (channel: SupportChannel, customerEmail: string) => Promise<SubscriptionRequest | null>;
  /** End a source-based free preview after its final reconnecting interlude. */
  finishPreview: () => void;
  /** The WhatsApp destination for a request, or null when unavailable. */
  whatsappLinkFor: (request: SubscriptionRequest, message?: string) => string | null;
}

function randomBetween(min: number, max: number): number {
  return max <= min ? min : min + Math.floor(Math.random() * (max - min));
}

interface GateOptions {
  sessionId: string;
  profileId: string;
  profileName: string;
  customerEmail: string;
  /** The gate only runs once the call is genuinely active with media playing. */
  armed: boolean;
  /**
   * True when this call was authorised by a Subscription Access ID.
   *
   * The checkpoint is the UNPAID preview gate. Access was already validated
   * before any device was requested, so running it again would interrupt a call
   * somebody has paid for to ask them to pay for it.
   */
  authorized: boolean;
  /** Configured support number, in whatever form storage holds it. */
  whatsappNumber: string | null;
  /**
   * Where the flow starts. Defaults to the in-call preview; the standalone
   * plans page opens straight onto the plans, with no call behind it.
   */
  initialStatus?: CallAccessStatus;
  /**
   * No access. The call must END here — completely, with every track stopped —
   * before the access screen is shown. There is no resuming it afterwards.
   */
  onAccessRequired: () => void;
  /** Record-only hooks for the session timeline. Never used for control flow. */
  onCheckStarted?: () => void;
  onAccessGranted?: () => void;
  onRequestCreated?: (request: SubscriptionRequest) => void;
}

/**
 * Runs the subscription checkpoint: preview, check, and then either nothing at
 * all or the end of the call.
 *
 * Access is read from the repository rather than remembered, so a grant an admin
 * confirms in another tab is picked up here.
 */
export function useCallAccessGate({
  sessionId,
  profileId,
  profileName,
  customerEmail,
  armed,
  authorized,
  whatsappNumber,
  initialStatus = "previewing",
  onAccessRequired,
  onCheckStarted,
  onAccessGranted,
  onRequestCreated,
}: GateOptions): CallAccessGate {
  const [status, setStatus] = useState<CallAccessStatus>(initialStatus);
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan | null>(null);
  const [request, setRequest] = useState<SubscriptionRequest | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const settled = useRef(false);

  /**
   * Callbacks live in a ref so that a parent re-rendering cannot restart the
   * preview timer. The check has to run once per call, not once per render.
   */
  const callbacks = useRef({ onAccessRequired, onCheckStarted, onAccessGranted, onRequestCreated });
  callbacks.current = { onAccessRequired, onCheckStarted, onAccessGranted, onRequestCreated };

  /**
   * A new call is a new checkpoint. Start New Call navigates to a fresh session
   * id without unmounting this route, so the gate is reset here rather than
   * being left holding the previous call's verdict.
   */
  const [gateSessionId, setGateSessionId] = useState(sessionId);
  if (gateSessionId !== sessionId) {
    setGateSessionId(sessionId);
    setStatus(initialStatus);
    setSelectedPlan(null);
    setRequest(null);
    settled.current = false;
  }

  // Plans are read once and shared by every sheet.
  useEffect(() => {
    let cancelled = false;
    void subscriptionRepository
      .listPlans()
      .then((all) => {
        if (!cancelled) setPlans(all.filter((plan) => plan.isActive));
      })
      .catch((error: unknown) => logDiagnostic("plans", error))
      .finally(() => {
        if (!cancelled) setPlansLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Preview, check, then live with the answer.
   *
   * Nothing in here touches the media. The remote clip, the camera, the
   * microphone and the timer all keep running from the first frame until either
   * the check passes — in which case they simply carry on — or `onAccessRequired`
   * ends the call.
   */
  useEffect(() => {
    if (!armed || authorized || settled.current) return;

    let cancelled = false;
    const timers: number[] = [];
    const previewMs = randomBetween(SUBSCRIPTION_TIMINGS.previewMinMs, SUBSCRIPTION_TIMINGS.previewMaxMs);

    timers.push(
      window.setTimeout(() => {
        if (cancelled) return;
        setStatus("checking");
        callbacks.current.onCheckStarted?.();

        const checkMs = randomBetween(SUBSCRIPTION_TIMINGS.checkMinMs, SUBSCRIPTION_TIMINGS.checkMaxMs);
        timers.push(
          window.setTimeout(() => {
            if (cancelled) return;
            void subscriptionRepository
              .claimAccess({ sessionId, customerEmail })
              .then((grant) => {
                if (cancelled) return;
                settled.current = true;

                if (grant) {
                  setStatus("granted");
                  callbacks.current.onAccessGranted?.();
                  return;
                }

                // No access: the call is over. Ending it is the first thing that
                // happens, before anything is drawn.
                setStatus("required");
                callbacks.current.onAccessRequired();
              })
              .catch((error: unknown) => {
                logDiagnostic("access-check", error);
                if (cancelled) return;
                settled.current = true;
                setStatus("required");
                callbacks.current.onAccessRequired();
              });
          }, checkMs),
        );
      }, previewMs),
    );

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [armed, authorized, customerEmail, sessionId]);

  /**
   * Support confirming a payment — in the admin dashboard, in another tab —
   * reaches the waiting customer here. Storage stays the source of truth; this
   * only says "look again".
   */
  const watchForConfirmation = status === "payment_pending";

  useEffect(() => {
    if (!watchForConfirmation) return;

    const requestId = request?.id;
    const look = () => {
      if (!requestId) return;
      void subscriptionRepository
        .getRequest(requestId)
        .then((current) => {
          if (current?.status === "confirmed") {
            setRequest(current);
            setStatus("confirmed");
          }
        })
        .catch((error: unknown) => logDiagnostic("access-confirm-poll", error));
    };

    const poll = window.setInterval(look, 4000);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(LOCAL_EVENT_CHANNEL);
      channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "subscription-confirmed") look();
      };
    }

    return () => {
      window.clearInterval(poll);
      channel?.close();
    };
  }, [request?.id, watchForConfirmation]);

  const startPayment = useCallback(
    async (channel: SupportChannel, email: string) => {
      if (!selectedPlan) return null;
      try {
        const created = await subscriptionRepository.createRequest({
          sessionId,
          profileId,
          profileName,
          customerEmail: email,
          planId: selectedPlan.id,
          planNameSnapshot: selectedPlan.displayName,
          amountMinorUnits: selectedPlan.priceMinorUnits,
          currencyCode: selectedPlan.currencyCode,
          channel,
        });
        setRequest(created);
        setStatus("payment_pending");
        callbacks.current.onRequestCreated?.(created);
        return created;
      } catch (error) {
        logDiagnostic("create-request", error);
        return null;
      }
    },
    [profileId, profileName, selectedPlan, sessionId],
  );

  const finishPreview = useCallback(() => {
    if (authorized || settled.current) return;
    settled.current = true;
    setStatus("required");
    callbacks.current.onAccessRequired();
  }, [authorized]);

  const whatsappLinkFor = useCallback(
    (target: SubscriptionRequest, message?: string) => {
      const price = formatMinorUnits(target.amountMinorUnits, target.currencyCode);
      const features = selectedPlan?.features.map((feature) => `- ${feature}`).join("\n") ?? "";
      const duration = selectedPlan?.sessionDurationMinutes;
      const details = [
        `Hello CallaStar Support. I am ready to subscribe to ${target.planNameSnapshot} for ${price}.`,
        duration ? `It includes sessions of up to ${duration} minutes.` : "",
        features ? `Package offers:\n${features}` : "",
        `Please help me complete the subscription. Request reference: ${target.reference}.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      return buildWhatsappLink(whatsappNumber, message ?? details);
    },
    [selectedPlan, whatsappNumber],
  );

  return {
    status,
    blocksCall: status !== "previewing" && status !== "checking" && status !== "granted",
    selectedPlan,
    request,
    plans,
    plansLoading,
    whatsappNumber,
    openPlans: useCallback(() => setStatus("selecting_plan"), []),
    choosePlan: useCallback((plan: SubscriptionPlan) => {
      setSelectedPlan(plan);
      setRequest(null);
      setStatus("payment_method");
    }, []),
    backToPlans: useCallback(() => setStatus("selecting_plan"), []),
    startPayment,
    finishPreview,
    whatsappLinkFor,
  };
}

