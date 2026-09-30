import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { SUPPORT_LIMITS } from "@/lib/config";
import { formatFileSize } from "@/lib/utils";
import type { MessageSender, SupportMessageView } from "@/services/support/types";

import { useAttachmentUrl, type SupportConversationState } from "./hooks/useSupportConversation";
import { useVisualViewport } from "./hooks/useVisualViewport";

interface SupportChatProps {
  state: SupportConversationState;
  /** Which side of the conversation is reading, so "mine" can be aligned. */
  viewer: MessageSender;
  title: string;
  subtitle: string;
  onBack: () => void;
  backLabel?: string;
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
}: SupportChatProps) {
  const { t } = useTranslation();
  const { messages, loading, sending, error, send } = state;
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<SupportMessageView | null>(null);
  const [viewing, setViewing] = useState<{ assetId: string; fileName: string } | null>(null);
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
  }, [messages.length]);

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
    if (sending) return;
    if (draft.trim().length === 0 && !attachment) return;

    const sent = await send({ body: draft, attachment, replyToMessageId: replyTo?.message.id ?? null });
    if (!sent) return;

    setDraft("");
    setAttachment(null);
    setReplyTo(null);
    if (fileInput.current) fileInput.current.value = "";
    composer.current?.focus();
  };

  let lastDay = "";

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <button type="button" className="chat-back" onClick={onBack} aria-label={backLabel}>
          <Icon name="chevron" className="size-5" />
        </button>
        <span className="chat-header-text">
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        {headerAction}
        <span className="chat-header-badge" aria-hidden="true">
          <Icon name="shield" className="size-4" />
        </span>
      </header>

      <div className="chat-thread" role="log" aria-live="polite" aria-label="Conversation">
        {loading && <p className="chat-note">{t("common.loading")}</p>}

        {!loading && messages.length === 0 && (
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
            </div>
          );
        })}

        <div ref={endOfThread} />
      </div>

      {error && <p className="chat-error">{error}</p>}

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
