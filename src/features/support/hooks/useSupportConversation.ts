import { useCallback, useEffect, useRef, useState } from "react";

import { LOCAL_EVENT_CHANNEL, broadcastLocalEvent } from "@/lib/localEvents";
import { logDiagnostic } from "@/lib/utils";
import { notifyAdmin } from "@/services/notifications/repository";
import { supportRepository } from "@/services/support/repository";
import type { MessageSender, SupportConversation, SupportMessageView } from "@/services/support/types";

export interface SupportConversationState {
  conversation: SupportConversation | null;
  messages: SupportMessageView[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  send: (input: { body: string; attachment?: File | null; replyToMessageId?: string | null }) => Promise<boolean>;
  reload: () => void;
}

/**
 * One side of a support conversation.
 *
 * Both sides are in the same browser while there is no backend, so the other
 * party's messages arrive through the local event channel rather than a socket.
 * The interval behind it is a safety net for a tab that missed a broadcast, not
 * the mechanism.
 */
export function useSupportConversation(
  conversationId: string | null,
  viewer: Exclude<MessageSender, "assistant">,
): SupportConversationState {
  const [conversation, setConversation] = useState<SupportConversation | null>(null);
  const [messages, setMessages] = useState<SupportMessageView[]>([]);
  const [loading, setLoading] = useState(conversationId !== null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (showSpinner: boolean) => {
      if (!conversationId) {
        setConversation(null);
        setMessages([]);
        setLoading(false);
        return;
      }

      if (showSpinner) setLoading(true);
      try {
        const [thread, list] = await Promise.all([
          supportRepository.getConversation(conversationId),
          supportRepository.listMessages(conversationId),
        ]);
        if (!mounted.current) return;
        setConversation(thread);
        setMessages(list);
        setError(null);
        // Looking at a thread is what marks it read; nothing else does.
        await supportRepository.markRead(conversationId, viewer);
      } catch (cause) {
        logDiagnostic("support-load", cause);
        if (mounted.current) setError("We could not load this conversation.");
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [conversationId, viewer],
  );

  useEffect(() => {
    void load(true);
  }, [load, nonce]);

  /** The other side wrote something. */
  useEffect(() => {
    if (!conversationId) return;

    const refresh = () => void load(false);
    const poll = window.setInterval(refresh, 5000);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(LOCAL_EVENT_CHANNEL);
      channel.onmessage = (event: MessageEvent<{ type?: string; conversationId?: string }>) => {
        if (event.data?.type !== "support-message") return;
        if (event.data.conversationId && event.data.conversationId !== conversationId) return;
        refresh();
      };
    }

    return () => {
      window.clearInterval(poll);
      channel?.close();
    };
  }, [conversationId, load]);

  const send = useCallback<SupportConversationState["send"]>(
    async ({ body, attachment = null, replyToMessageId = null }) => {
      if (!conversationId) return false;
      if (body.trim().length === 0 && !attachment) return false;

      setSending(true);
      try {
        const sent = await supportRepository.sendMessage({
          conversationId,
          sender: viewer,
          body,
          attachment,
          replyToMessageId,
        });

        if (viewer === "customer") {
          notifyAdmin({
            type: attachment ? "payment_proof_submitted" : "support_message_received",
            title: attachment ? "Payment proof received" : "New customer care message",
            body: `${sent.conversation.customerEmail}: ${sent.conversation.lastMessagePreview}`,
            entityKind: "support_conversation",
            entityId: conversationId,
          });
        }

        // Tell the other side before reloading, so both views land together.
        broadcastLocalEvent("support-message", { conversationId });

        await load(false);
        return true;
      } catch (cause) {
        logDiagnostic("support-send", cause);
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : "That message could not be sent.");
        }
        return false;
      } finally {
        if (mounted.current) setSending(false);
      }
    },
    [conversationId, load, viewer],
  );

  return {
    conversation,
    messages,
    loading,
    sending,
    error,
    send,
    reload: useCallback(() => setNonce((value) => value + 1), []),
  };
}

/**
 * An object URL for one attachment, revoked when it is no longer shown.
 *
 * Exactly one URL per asset, owned here: the bubble that renders it never
 * creates or revokes anything itself.
 */
export function useAttachmentUrl(assetId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!assetId) {
      setUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void supportRepository
      .getAttachment(assetId)
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((error: unknown) => logDiagnostic("support-attachment", error));

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [assetId]);

  return url;
}
