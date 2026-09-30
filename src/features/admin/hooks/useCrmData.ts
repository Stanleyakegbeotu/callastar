import { useCallback, useEffect, useState } from "react";

import { LOCAL_EVENT_CHANNEL } from "@/lib/localEvents";
import { notificationRepository } from "@/services/notifications/repository";
import type { AdminNotification } from "@/services/notifications/types";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import type {
  SubscriptionPlan,
  SubscriptionPlanId,
  SubscriptionRequest,
  SubscriptionRequestFilters,
} from "@/services/subscriptions/types";
import { supportRepository } from "@/services/support/repository";
import type { ConversationFilters, SupportConversation } from "@/services/support/types";

import { useAsync, type AsyncState } from "./useAdminData";

/**
 * Reads for the subscription, customer care and notification screens.
 *
 * Same contract as the rest of the dashboard: everything goes through a
 * repository, and every hook reports real loading and error states because none
 * of these reads are instant.
 */

export function usePlans(): AsyncState<SubscriptionPlan[]> {
  return useAsync(useCallback(() => subscriptionRepository.listPlans(), []), []);
}

export function usePlan(id: SubscriptionPlanId | undefined): AsyncState<SubscriptionPlan | null> {
  return useAsync(
    useCallback(() => (id ? subscriptionRepository.getPlan(id) : Promise.resolve(null)), [id]),
    null,
  );
}

export function useSubscriptionRequests(filters: SubscriptionRequestFilters = {}): AsyncState<SubscriptionRequest[]> {
  const { status, channel, limit } = filters;
  return useAsync(
    useCallback(() => subscriptionRepository.listRequests({ status, channel, limit }), [channel, limit, status]),
    [],
  );
}

export function useSubscriptionRequest(id: string | undefined): AsyncState<SubscriptionRequest | null> {
  return useAsync(
    useCallback(() => (id ? subscriptionRepository.getRequest(id) : Promise.resolve(null)), [id]),
    null,
  );
}

/** Every request a caller's session produced, for the session detail page. */
export function useSessionSubscriptionRequests(sessionId: string | undefined): AsyncState<SubscriptionRequest[]> {
  return useAsync(
    useCallback(
      () => (sessionId ? subscriptionRepository.listSessionRequests(sessionId) : Promise.resolve([])),
      [sessionId],
    ),
    [],
  );
}

export function useSupportConversations(filters: ConversationFilters = {}): AsyncState<SupportConversation[]> {
  const { status, unreadOnly, search, limit } = filters;
  return useAsync(
    useCallback(
      () => supportRepository.listConversations({ status, unreadOnly, search, limit }),
      [limit, search, status, unreadOnly],
    ),
    [],
  );
}

export function useNotifications(unreadOnly = false): AsyncState<AdminNotification[]> {
  return useAsync(useCallback(() => notificationRepository.list({ unreadOnly }), [unreadOnly]), []);
}

export interface CrmBadges {
  /** Requests an operator still has to do something about. */
  openRequests: number;
  /** Conversations with an unread customer message. */
  unreadConversations: number;
  unreadNotifications: number;
  reload: () => void;
}

/**
 * The counters on the navigation.
 *
 * Refreshed when another tab says something happened, rather than on a timer:
 * a customer sending a message or requesting a plan is exactly what these count,
 * and both broadcast.
 */
export function useCrmBadges(): CrmBadges {
  const [counts, setCounts] = useState({ openRequests: 0, unreadConversations: 0, unreadNotifications: 0 });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;

    const read = () => {
      void Promise.all([
        subscriptionRepository.countRequestsByStatus("awaiting_payment"),
        subscriptionRepository.countRequestsByStatus("proof_submitted"),
        subscriptionRepository.countRequestsByStatus("reviewing"),
        supportRepository.countUnreadForAdmin(),
        notificationRepository.countUnread(),
      ])
        .then(([awaiting, proof, reviewing, unreadConversations, unreadNotifications]) => {
          if (cancelled) return;
          setCounts({
            openRequests: awaiting + proof + reviewing,
            unreadConversations,
            unreadNotifications,
          });
        })
        // A badge is decoration on top of the page it sits beside: if the count
        // cannot be read, the navigation still works without it.
        .catch(() => undefined);
    };

    read();

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(LOCAL_EVENT_CHANNEL);
      channel.onmessage = read;
    }

    return () => {
      cancelled = true;
      channel?.close();
    };
  }, [nonce]);

  return { ...counts, reload };
}
