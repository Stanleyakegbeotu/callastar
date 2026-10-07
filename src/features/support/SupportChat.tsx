import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { CallaStarMark } from "@/components/branding/CallaStarMark";
import { SUPPORT_LIMITS } from "@/lib/config";
import { formatFileSize } from "@/lib/utils";
import type { SubscriptionPlan } from "@/services/subscriptions/types";
import { formatMinorUnits } from "@/services/subscriptions/money";
import type { MessageSender, SupportMessageView } from "@/services/support/types";

import { useAttachmentUrl, type SupportConversationState } from "./hooks/useSupportConversation";
import { useVisualViewport } from "./hooks/useVisualViewport";
import {
  answerSubscriptionDecision,
  continuePaymentMethodSelection,
  enterSubscriptionChat,
  markSupportChatExit,
  requestPaymentMethodHelp,
  selectPaymentMethod,
} from "./supportAutomation";
import { isPaymentMethod, PAYMENT_METHODS, type PaymentMethod } from "@/services/support/paymentMethods";

interface SupportChatProps {
  state: SupportConversationState;
  /** Which side of the conversation is reading, so "mine" can be aligned. */
  viewer: MessageSender;
  title: string;
  subtitle: string;
  onBack: () => void;
  backLabel?: string;
  packagePlan?: Pick<SubscriptionPlan, "id" | "displayName" | "priceMinorUnits" | "currencyCode" | "sortOrder" | "sessionDurationMinutes" | "description" | "features">;
  packageOptions?: Pick<SubscriptionPlan, "id" | "displayName" | "priceMinorUnits" | "currencyCode" | "sortOrder" | "sessionDurationMinutes" | "description" | "features">[];
  onSelectPackage?: (planId: SubscriptionPlan["id"]) => void | Promise<void>;
  onPaymentMethodSubmitted?: () => void | Promise<void>;
  onContinueToWhatsapp?: () => void;
  /**
   * An extra control for the header, such as the admin expand/collapse toggle.
   *
   * Passed in rather than built here so the public chat stays exactly as it is —
   * a caller has one chat and nothing to expand it into.
   */
  headerAction?: React.ReactNode;
}

function messageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function packagePrice(amountMinorUnits: number, currencyCode: string): string {
  return formatMinorUnits(amountMinorUnits, currencyCode);
}

function dayLabel(iso: string, t: (key: string) => string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return t("support.today");

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t("support.yesterday");

  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** How far a bubble has to be dragged before the drag counts as a reply. */
const REPLY_THRESHOLD = 56;

/**
 * A customer care conversation.
 *
 * The same component serves the customer and the operator; only `viewer`
 * differs, and it decides which side "mine" is. Messages are rendered exactly as
 * they were typed — a support thread is evidence, so nothing here reformats,
 * shortens or translates what either party said.
 */
export function SupportChat({
  state,
  viewer,
  title,
  subtitle,
  onBack,
  backLabel = "Back",
  headerAction,
  packagePlan,
  packageOptions = [],
  onSelectPackage,
  onPaymentMethodSubmitted,
  onContinueToWhatsapp,
}: SupportChatProps) {
  const { t } = useTranslation();
  const { messages, loading, sending, error, send } = state;
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<SupportMessageView | null>(null);
  const [viewing, setViewing] = useState<{ assetId: string; fileName: string } | null>(null);
  const [entryBusy, setEntryBusy] = useState(false);
  const [flowBusy, setFlowBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [packageMenuOpen, setPackageMenuOpen] = useState(false);
  const enteredAt = useRef(Date.now());
  const entryStarted = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const endOfThread = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  // The composer has to stay above the on-screen keyboard.
  useVisualViewport();

  const preview = useMemo(() => (attachment ? URL.createObjectURL(attachment) : null), [attachment]);
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  // New messages should be visible without scrolling for them.
  useEffect(() => {
    endOfThread.current?.scrollIntoView({ block: "end" });
  }, [entryBusy, flowBusy, messages.length]);

  useEffect(() => {
    if (viewer !== "customer" || loading || !state.conversation || !packagePlan) return;
    if (state.conversation.checkoutDraft?.planId !== packagePlan.id) return;
    if (entryStarted.current === state.conversation.id) return;
    entryStarted.current = state.conversation.id;
    enteredAt.current = Date.now();
    setEntryBusy(true);
    void enterSubscriptionChat(state.conversation.id, packagePlan, enteredAt.current, state.reload)
      .catch((cause: unknown) => setFlowError(cause instanceof Error ? cause.message : "The chat greeting could not be loaded."))
      .finally(() => {
        state.reload();
        setEntryBusy(false);
      });
  }, [loading, packagePlan, state.conversation, state.reload, viewer]);

  const flowStatus = state.conversation?.checkoutDraft?.subscriptionFollowupStatus ?? null;
  const adminHasTakenOver = messages.some(({ message }) => message.sender === "admin");

  const chooseSubscription = async (choice: "yes" | "no") => {
    if (flowBusy || flowStatus !== "awaiting_decision" || adminHasTakenOver || !state.conversation || !packagePlan) return false;
    setFlowBusy(true);
    setFlowError(null);
    try {
      return await answerSubscriptionDecision(state.conversation.id, packagePlan.id, choice, state.reload);
    } catch (cause) {
      setFlowError(cause instanceof Error ? cause.message : "This reply could not be sent. Please try again.");
      return false;
    } finally {
      setFlowBusy(false);
    }
  };

  const currentCheckoutIntentId = state.conversation && packagePlan
    ? state.conversation.checkoutDraft?.checkoutIntentId ?? `${state.conversation.id}:${packagePlan.id}`
    : null;

  const runPaymentAction = async (action: "continue" | "help") => {
    const conversation = state.conversation;
    const checkoutDraft = conversation?.checkoutDraft;
    const visit = checkoutDraft?.lastAutomatedVisitKey ?? "current";
    if (flowBusy || flowStatus !== "awaiting_payment_method" || adminHasTakenOver || !conversation || !packagePlan || !currentCheckoutIntentId) return;
    setFlowBusy(true);
    setFlowError(null);
    try {
      if (action === "continue") {
        await continuePaymentMethodSelection(conversation.id, packagePlan.id, currentCheckoutIntentId, visit, state.reload);
      } else {
        await requestPaymentMethodHelp(conversation.id, packagePlan.id, currentCheckoutIntentId, visit, state.reload);
      }
    } catch (cause) {
      setFlowError(cause instanceof Error ? cause.message : "That chat action could not be completed.");
    } finally {
      state.reload();
      setFlowBusy(false);
    }
  };

  const choosePaymentMethod = async (method: PaymentMethod) => {
    const conversation = state.conversation;
    if (flowBusy || flowStatus !== "awaiting_payment_method" || adminHasTakenOver || !conversation || !packagePlan || !currentCheckoutIntentId) return;
    setFlowBusy(true);
    setFlowError(null);
    try {
      if (!await selectPaymentMethod(conversation.id, packagePlan.id, currentCheckoutIntentId, method, state.reload)) return;
      try {
        await onPaymentMethodSubmitted?.();
      } catch (cause) {
        setFlowError(cause instanceof Error
          ? `Your payment preference was saved, but the request could not be created: ${cause.message}`
          : "Your payment preference was saved, but the payment request could not be created.");
      }
    } catch (cause) {
      setFlowError(cause instanceof Error ? cause.message : "The payment preference could not be saved.");
    } finally {
      state.reload();
      setFlowBusy(false);
    }
  };

  const detectSubscriptionChoice = (value: string): "yes" | "no" | null => {
    const normalized = value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.!?,]/g, "");
    if (/^(yes|y|yeah|yep|sure|absolutely|continue|continue payment|go ahead|si|sim|ja|oui|claro|certo|i want to continue|i would like to continue|i['’]d like to continue)(\b|$)/.test(normalized)) return "yes";
    if (/^(no|n|nope|not now|not yet|nein|non|nao|not interested|i do not want to continue|i don't want to continue)(\b|$)/.test(normalized)) return "no";
    return null;
  };

  const chooseFile = (file: File | null) => {
    setAttachmentError(null);
    if (!file) {
      setAttachment(null);
      return;
    }

    if (!file.type.startsWith("image/")) {
      setAttachmentError(t("errors.notAnImage"));
      return;
    }
    if (file.size > SUPPORT_LIMITS.MAX_ATTACHMENT_BYTES) {
      setAttachmentError(`${t("errors.imageTooLarge")} ${formatFileSize(SUPPORT_LIMITS.MAX_ATTACHMENT_BYTES)} max.`);
      return;
    }
    setAttachment(file);
  };

  const submit = async () => {
    if (sending || flowBusy) return;
    if (draft.trim().length === 0 && !attachment) return;

    const typedBody = draft;
    if (flowStatus === "awaiting_decision" && !attachment && !adminHasTakenOver) {
      const choice = detectSubscriptionChoice(typedBody);
      if (choice) {
        if (await chooseSubscription(choice)) setDraft("");
        return;
      }
    }

    const sent = await send({ body: typedBody, attachment, replyToMessageId: replyTo?.message.id ?? null });
    if (!sent) return;

    setDraft("");
    setAttachment(null);
    setReplyTo(null);
    if (fileInput.current) fileInput.current.value = "";
    composer.current?.focus();
  };

  let lastDay = "";
  const lastAssistantMessage = [...messages].reverse().find(({ message }) => message.sender === "assistant")?.message;
  const decisionAnchorId = [...messages].reverse().find(({ message }) =>
    message.sender === "assistant" &&
    (message.id.endsWith(":intro-question") || message.id.includes(":return:") || message.id.includes(":package-change:")),
  )?.message.id;
  const showPaymentContinuation = viewer === "customer" && !adminHasTakenOver && flowStatus === "awaiting_payment_method" &&
    Boolean(lastAssistantMessage?.id.includes(":return:"));
  const showPaymentMethods = viewer === "customer" && !adminHasTakenOver && flowStatus === "awaiting_payment_method" &&
    Boolean(lastAssistantMessage?.id.includes(":payment-method-prompt:"));

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <button type="button" className="chat-back" onClick={() => {
          if (viewer === "customer" && state.conversation) markSupportChatExit(state.conversation.id);
          onBack();
        }} aria-label={backLabel}>
          <Icon name="chevron" className="size-5" />
        </button>
        <span className="chat-header-text">
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        {packagePlan && (
          <button
            type="button"
            className="chat-package-trigger"
            aria-expanded={packageMenuOpen}
            aria-label={`${packagePlan.displayName}, ${packagePrice(packagePlan.priceMinorUnits, packagePlan.currencyCode)}. ${t("support.viewPackageDetails")}`}
            onClick={() => setPackageMenuOpen((open) => !open)}
          >
            <span>{packagePlan.displayName}</span>
            <strong>{packagePrice(packagePlan.priceMinorUnits, packagePlan.currencyCode)}</strong>
            <Icon name="chevron" className={`size-4 ${packageMenuOpen ? "chat-package-chevron-open" : ""}`} />
          </button>
        )}
        {headerAction}
        <span className="chat-header-badge" aria-hidden="true">
          <Icon name="shield" className="size-4" />
        </span>
        {packageMenuOpen && packagePlan && (
          <div className="chat-package-menu">
            <div className="chat-package-current">
              <div className="chat-package-menu-title">
                <strong>{packagePlan.displayName}</strong>
                <span>{packagePrice(packagePlan.priceMinorUnits, packagePlan.currencyCode)}</span>
              </div>
              <p>{packagePlan.description}</p>
              <p className="chat-package-duration">{t("support.packageDuration", { minutes: packagePlan.sessionDurationMinutes })}</p>
              <ul>
                {packagePlan.features.map((feature) => <li key={feature}>{feature}</li>)}
              </ul>
            </div>
            {onSelectPackage && packageOptions.some((option) => option.id !== packagePlan.id) && (
              <div className="chat-package-options">
                <strong>{t("support.changePackage")}</strong>
                {packageOptions.filter((option) => option.id !== packagePlan.id).map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    onClick={() => {
                      setPackageMenuOpen(false);
                      void Promise.resolve(onSelectPackage(option.id)).catch((cause: unknown) => {
                        setFlowError(cause instanceof Error ? cause.message : "That package could not be selected.");
                      });
                    }}
                  >
                    <span>
                      <strong>{option.displayName}</strong>
                      <small>{t("support.packageDuration", { minutes: option.sessionDurationMinutes })}</small>
                    </span>
                    <b>{packagePrice(option.priceMinorUnits, option.currencyCode)}</b>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </header>

      <div className="chat-thread" role="log" aria-live="polite" aria-label="Conversation">
        {loading && <p className="chat-note">{t("common.loading")}</p>}

        {!loading && messages.length === 0 && !packagePlan && !entryBusy && (
          <div className="chat-empty">
            <span className="chat-empty-icon">
              <Icon name="chat" className="size-7" />
            </span>
            <h2>{t("support.emptyTitle")}</h2>
            <p>{t("support.emptyCopy")}</p>
          </div>
        )}

        {messages.map((view) => {
          const day = dayLabel(view.message.createdAt, t);
          const showDay = day !== lastDay;
          lastDay = day;

          return (
            <div key={view.message.id}>
              {showDay && <p className="chat-day">{day}</p>}
              <MessageBubble
                view={view}
                mine={view.message.sender === viewer}
                onReply={() => setReplyTo(view)}
                onOpenImage={(assetId, fileName) => setViewing({ assetId, fileName })}
              />
              {viewer === "customer" && !adminHasTakenOver && flowStatus === "awaiting_decision" && view.message.id === decisionAnchorId && (
                <div className="chat-welcome-actions chat-decision-actions">
                  <button type="button" disabled={flowBusy} onClick={() => void chooseSubscription("yes")}>
                    {t("support.subscriptionYes")}
                  </button>
                  <button type="button" disabled={flowBusy} onClick={() => void chooseSubscription("no")}>
                    {t("support.subscriptionNo")}
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {showPaymentContinuation && (
          <div className="chat-payment-actions" aria-label="Payment continuation actions">
            <button type="button" disabled={flowBusy} onClick={() => void runPaymentAction("continue")}>
              Continue Payment
            </button>
            <button type="button" className="chat-payment-secondary" disabled={flowBusy} onClick={() => void runPaymentAction("help")}>
              I Need Help
            </button>
          </div>
        )}

        {showPaymentMethods && (
          <div className="chat-payment-methods" aria-label="Choose a payment method">
            {PAYMENT_METHODS.map(({ id, label }) => (
              <button
                type="button"
                key={id}
                disabled={flowBusy}
                aria-label={`Select ${label} as payment method`}
                onClick={() => void choosePaymentMethod(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {viewer === "customer" && onContinueToWhatsapp && isPaymentMethod(state.conversation?.checkoutDraft?.selectedPaymentMethod) && (
          <div className="chat-welcome-actions chat-decision-actions">
            <button type="button" onClick={onContinueToWhatsapp}>{t("support.continueToWhatsapp")}</button>
          </div>
        )}

        {(entryBusy || flowBusy) && !adminHasTakenOver && (
          <div className="chat-row chat-row-welcome">
            <span className="chat-brand-avatar" role="img" aria-label="CallaStar">
              <CallaStarMark size={22} />
            </span>
            <div className="chat-bubble chat-bubble-theirs chat-welcome-bubble">
              <span className="chat-typing" role="status" aria-label={t("support.agentTyping")}>
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}

        <div ref={endOfThread} />
      </div>

      {(error || flowError) && <p className="chat-error">{error ?? flowError}</p>}

      <div className="chat-composer-wrap">
        {replyTo && (
          <div className="chat-reply-preview">
            <span className="chat-reply-bar" aria-hidden="true" />
            <span className="chat-reply-text">
              <strong>Replying to {replyTo.message.sender === viewer ? "yourself" : "CallaStar"}</strong>
              <small>{replyTo.message.body.trim() || "Image"}</small>
            </span>
            <button type="button" className="chat-reply-cancel" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
              <Icon name="close" className="size-4" />
            </button>
          </div>
        )}

        {attachment && preview && (
          <div className="chat-attach-preview">
            <img src={preview} alt={attachment.name} />
            <span className="chat-attach-meta">
              <strong>{attachment.name}</strong>
              <small>{formatFileSize(attachment.size)}</small>
            </span>
            <button
              type="button"
              className="chat-reply-cancel"
              onClick={() => chooseFile(null)}
              aria-label="Remove attachment"
            >
              <Icon name="close" className="size-4" />
            </button>
          </div>
        )}

        {attachmentError && <p className="chat-error">{attachmentError}</p>}

        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="chat-attach" aria-label={t("support.attach")}>
            <Icon name="paperclip" className="size-5" />
            <input
              ref={fileInput}
              type="file"
              accept={SUPPORT_LIMITS.ATTACHMENT_MIME_TYPES.join(",")}
              onChange={(event) => chooseFile(event.currentTarget.files?.[0] ?? null)}
            />
          </label>

          {/* Enter inserts a newline. A chat message is often more than one
              line, and losing a half-written one to a stray Return is worse
              than reaching for the send button. */}
          <textarea
            ref={composer}
            className="chat-input"
            value={draft}
            rows={1}
            placeholder={t("support.messagePlaceholder")}
            maxLength={SUPPORT_LIMITS.MESSAGE_MAX}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />

          <button
            type="submit"
            className="chat-send"
            disabled={sending || (draft.trim().length === 0 && !attachment)}
            aria-label={t("support.send")}
          >
            <Icon name="send" className="size-5" />
          </button>
        </form>
      </div>

      {viewing && (
        <ImageViewer assetId={viewing.assetId} fileName={viewing.fileName} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

interface BubbleProps {
  view: SupportMessageView;
  mine: boolean;
  onReply: () => void;
  onOpenImage: (assetId: string, fileName: string) => void;
}

/**
 * One message.
 *
 * Draggable towards the middle to reply, the way every chat app on a phone
 * works. The same action has a button, because a drag is not available to
 * someone using a keyboard or a screen reader.
 */
function MessageBubble({ view, mine, onReply, onOpenImage }: BubbleProps) {
  const { message, asset, replyTo } = view;
  const url = useAttachmentUrl(asset?.id ?? null);
  const [offset, setOffset] = useState(0);
  const startX = useRef<number | null>(null);

  const imageOnly = asset !== null && message.body.trim().length === 0;
  const isAdminMessage = message.sender !== "customer";
  const brandAvatar = isAdminMessage ? (
    <span className="chat-brand-avatar" role="img" aria-label="CallaStar">
      <CallaStarMark size={22} />
    </span>
  ) : null;

  return (
    <div
      className={`chat-row ${mine ? "chat-row-mine" : ""}`.trim()}
      onTouchStart={(event) => {
        startX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchMove={(event) => {
        if (startX.current === null) return;
        const delta = (event.touches[0]?.clientX ?? 0) - startX.current;
        // Only towards the centre of the screen, and never further than the
        // gesture needs to be understood.
        const travel = mine ? Math.min(0, delta) : Math.max(0, delta);
        setOffset(Math.max(-72, Math.min(72, travel)));
      }}
      onTouchEnd={() => {
        if (Math.abs(offset) >= REPLY_THRESHOLD) onReply();
        startX.current = null;
        setOffset(0);
      }}
    >
      <span className="chat-swipe-hint" aria-hidden="true">
        <Icon name="reply" className="size-4" />
      </span>

      {isAdminMessage && !mine && brandAvatar}

      <div
        className={`chat-bubble ${mine ? "chat-bubble-mine" : "chat-bubble-theirs"} ${
          imageOnly ? "chat-bubble-image" : ""
        }`.trim()}
        style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
      >
        {replyTo && (
          <span className="chat-quote">
            <strong>{replyTo.sender === message.sender ? "Earlier message" : "In reply to"}</strong>
            <small>{replyTo.body.trim() || (replyTo.hasAttachment ? "Image" : "")}</small>
          </span>
        )}

        {asset && (
          <button
            type="button"
            className="chat-image"
            onClick={() => onOpenImage(asset.id, asset.fileName)}
            aria-label={`Open image ${asset.fileName}`}
          >
            {url ? <img src={url} alt={asset.fileName} /> : <span className="chat-image-loading" />}
          </button>
        )}

        {message.body.trim().length > 0 && <span className="chat-text">{message.body}</span>}

        <span className="chat-meta">{messageTime(message.createdAt)}</span>
      </div>

      {isAdminMessage && mine && brandAvatar}

      <button type="button" className="chat-reply-action" onClick={onReply} aria-label="Reply to this message">
        <Icon name="reply" className="size-4" />
      </button>
    </div>
  );
}

/** Full-screen view of one attachment, with a way to keep it. */
function ImageViewer({
  assetId,
  fileName,
  onClose,
}: {
  assetId: string;
  fileName: string;
  onClose: () => void;
}) {
  const url = useAttachmentUrl(assetId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={fileName}>
      <div className="image-viewer-bar">
        <button type="button" onClick={onClose} aria-label="Close image">
          <Icon name="close" className="size-5" />
        </button>
        <span>{fileName}</span>
        {url && (
          <a href={url} download={fileName} aria-label="Download image">
            <Icon name="download" className="size-5" />
          </a>
        )}
      </div>
      {url ? <img src={url} alt={fileName} /> : <p className="chat-note">Loading image…</p>}
    </div>
  );
}

export default SupportChat;
