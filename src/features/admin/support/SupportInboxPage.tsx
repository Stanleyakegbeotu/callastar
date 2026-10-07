import { useState } from "react";
import { Link } from "react-router-dom";

import { formatDateTime } from "@/lib/utils";
import type { ConversationStatus } from "@/services/support/types";

import { EmptyState } from "../components/EmptyState";
import { useSupportConversations } from "../hooks/useCrmData";
import { AdminPageHeader } from "../layout/AdminPageHeader";

const STATUS_FILTERS: { value: ConversationStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Needs reply" },
  { value: "pending", label: "Answered" },
  { value: "resolved", label: "Resolved" },
];

const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Needs reply",
  pending: "Answered",
  resolved: "Resolved",
};

const STATUS_TONE: Record<ConversationStatus, string> = {
  open: "warning",
  pending: "progress",
  resolved: "ready",
};

/**
 * Admin → Customer Care.
 *
 * An inbox, ordered by whoever wrote last. Built from the conversation summaries
 * alone — no thread is read and no attachment is fetched to render this list, so
 * it stays fast however many images customers have sent.
 */
export function SupportInboxPage() {
  const [status, setStatus] = useState<ConversationStatus | "all">("all");
  const [search, setSearch] = useState("");
  const { data: conversations, loading, error } = useSupportConversations({ status, search });

  return (
    <>
      <AdminPageHeader
        title="Customer Care"
        description="Conversations with customers, newest reply first."
      />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="admin-toolbar">
        <div className="admin-search">
          <label className="admin-visually-hidden" htmlFor="support-search">
            Search conversations
          </label>
          <input
            id="support-search"
            className="admin-input"
            type="search"
            placeholder="Search email, name or subject"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="admin-filters" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`admin-filter ${status === option.value ? "is-active" : ""}`}
              aria-pressed={status === option.value}
              onClick={() => setStatus(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="admin-hint">Loading conversations…</p>
      ) : conversations.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="When a customer opens customer care, or asks for help paying for a plan, their conversation appears here."
        />
      ) : (
        <ul className="admin-inbox">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <Link className="admin-inbox-row" to={`/admin/support/${conversation.id}`}>
                <span className="admin-inbox-main">
                  <span className="admin-inbox-head">
                    <strong>{conversation.customerName || conversation.customerEmail}</strong>
                    {conversation.unreadForAdmin > 0 && (
                      <span className="admin-inbox-unread" aria-label={`${conversation.unreadForAdmin} unread`}>
                        {conversation.unreadForAdmin}
                      </span>
                    )}
                  </span>
                  <span className="admin-inbox-subject">{conversation.customerEmail}</span>
                  <span className="admin-inbox-subject">{conversation.subject}</span>
                  <span className="admin-inbox-preview">
                    {conversation.lastMessageSender === "admin" && <em>You: </em>}
                    {conversation.lastMessagePreview || "No messages yet"}
                  </span>
                </span>
                <span className="admin-inbox-meta">
                  <span className={`admin-badge admin-badge-${STATUS_TONE[conversation.status]}`}>
                    {STATUS_LABELS[conversation.status]}
                  </span>
                  <small>{formatDateTime(conversation.lastMessageAt)}</small>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default SupportInboxPage;
