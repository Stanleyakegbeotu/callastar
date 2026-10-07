import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { logDiagnostic } from "@/lib/utils";
import { supportRepository } from "@/services/support/repository";
import type { ConversationStatus } from "@/services/support/types";

import { Icon } from "@/components/ui/Icon";
import { SupportChat } from "@/features/support/SupportChat";
import { useSupportConversation } from "@/features/support/hooks/useSupportConversation";

import { useToast } from "../components/ToastProvider";
import { AdminPageHeader } from "../layout/AdminPageHeader";

/**
 * Admin → Customer Care → one conversation.
 *
 * The same chat component the customer uses, from the other side: `viewer` is
 * what decides which messages are "mine". Messages are shown exactly as they
 * were typed — a support thread is a record of what was said, so nothing here
 * tidies, shortens or translates either party's words.
 */
export function AdminSupportThreadPage() {
  /**
   * Compact by default, on every screen size.
   *
   * Expanding is the operator's choice, never automatic — the embedded card is
   * what they asked to keep.
   */
  const [expanded, setExpanded] = useState(false);
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const state = useSupportConversation(conversationId ?? null, "admin");
  const conversation = state.conversation;

  if (state.loading && !conversation) return <p className="admin-hint">Loading conversation…</p>;

  if (!conversation) {
    return (
      <>
        <AdminPageHeader title="Conversation not found" description="This conversation is no longer stored here." />
        <Link className="admin-button admin-button-primary" to="/admin/support">
          Back to customer care
        </Link>
      </>
    );
  }

  const setStatus = async (status: ConversationStatus) => {
    try {
      await supportRepository.updateConversation(conversation.id, { status });
      toast.success(status === "resolved" ? "Conversation resolved." : "Conversation reopened.");
      state.reload();
    } catch (cause) {
      logDiagnostic("support-status", cause);
      toast.error("That change could not be saved.");
    }
  };

  return (
    <div className="admin-support-thread-page">
      <AdminPageHeader
        title={conversation.customerName || conversation.customerEmail}
        description={conversation.subject}
        eyebrow={
          <Link className="admin-link" to="/admin/support">
            Customer Care
          </Link>
        }
        actions={
          conversation.status === "resolved" ? (
            <button
              type="button"
              className="admin-button admin-button-secondary"
              onClick={() => void setStatus("open")}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="admin-button admin-button-secondary"
              onClick={() => void setStatus("resolved")}
            >
              Mark resolved
            </button>
          )
        }
      />

      {conversation.subscriptionRequestId && (
        <p className="admin-note">
          This conversation is about a subscription request.{" "}
          <Link className="admin-link" to={`/admin/subscriptions/${conversation.subscriptionRequestId}`}>
            Open the request
          </Link>
        </p>
      )}

      {/*
        One chat, two presentations.

        The compact card stays the default — it is what an operator wants while
        working through the dashboard. Expanding only changes this wrapper's
        class: the `SupportChat` element keeps its type and its position in the
        tree, so React preserves the whole subtree. That is what makes the draft
        text, the reply target, the attachment and the scroll position survive
        the switch, and what guarantees there is never a second chat instance or
        a second fetch.
      */}
      <section className={`admin-chat-panel ${expanded ? "is-expanded" : ""}`.trim()}>
        <SupportChat
          state={state}
          viewer="admin"
          title={conversation.customerName || "Customer"}
          subtitle={conversation.customerEmail}
          onBack={() => (expanded ? setExpanded(false) : navigate("/admin/support"))}
          backLabel={expanded ? "Collapse conversation" : "Back to customer care"}
          headerAction={
            <button
              type="button"
              className="chat-expand"
              onClick={() => setExpanded((open) => !open)}
              aria-label={expanded ? "Collapse conversation" : "Expand conversation"}
              aria-expanded={expanded}
            >
              <Icon name={expanded ? "minimize" : "maximize"} className="size-5" />
            </button>
          }
        />
      </section>
    </div>
  );
}

export default AdminSupportThreadPage;
