import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { broadcastLocalEvent } from "@/lib/localEvents";
import { formatDateTime, logDiagnostic } from "@/lib/utils";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import { supportRepository } from "@/services/support/repository";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/ToastProvider";
import { useSubscriptionRequest } from "../hooks/useCrmData";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { CHANNEL_LABELS, REQUEST_STATUS_LABELS, REQUEST_STATUS_TONE, formatPlanPrice } from "./subscriptionInsights";

type PendingAction = "confirm" | "reject" | null;

/**
 * One access request, and the three things an operator can do with it.
 *
 * Confirming is the only one that grants anything, and it is deliberately behind
 * a confirmation dialog: it is what lets somebody make a call they have not
 * otherwise paid for. It is also idempotent in the repository, so a double
 * click cannot issue two grants.
 */
export function SubscriptionRequestDetailPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const toast = useToast();
  const { data: request, loading, error, reload } = useSubscriptionRequest(requestId);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <p className="admin-hint">Loading request…</p>;
  if (error) {
    return (
      <p className="admin-error-banner" role="alert">
        {error}
      </p>
    );
  }
  if (!request) {
    return (
      <>
        <AdminPageHeader title="Request not found" description="This subscription request is no longer stored here." />
        <Link className="admin-button admin-button-primary" to="/admin/subscriptions">
          Back to subscriptions
        </Link>
      </>
    );
  }

  const markReviewing = async () => {
    setBusy(true);
    try {
      await subscriptionRepository.updateRequest(request.id, { status: "reviewing" });
      toast.success("Marked as reviewing.");
      reload();
    } catch (cause) {
      logDiagnostic("request-reviewing", cause);
      toast.error("That change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await subscriptionRepository.confirmRequest(request.id);
      // The customer may be sitting on the waiting screen in another tab.
      broadcastLocalEvent("subscription-confirmed", { requestId: request.id });
      toast.success("Subscription confirmed. The customer can start a new call.");
      setPending(null);
      reload();
    } catch (cause) {
      logDiagnostic("request-confirm", cause);
      toast.error("That subscription could not be confirmed.");
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await subscriptionRepository.updateRequest(request.id, { status: "needs_attention" });
      broadcastLocalEvent("subscription-confirmed", { requestId: request.id });
      toast.success("Marked as needing attention.");
      setPending(null);
      reload();
    } catch (cause) {
      logDiagnostic("request-reject", cause);
      toast.error("That change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const openConversation = async () => {
    const conversation =
      request.conversationId !== null
        ? await supportRepository.getConversation(request.conversationId)
        : await supportRepository.findConversationByEmail(request.customerEmail);
    return conversation;
  };

  const settled = request.status === "confirmed";

  return (
    <>
      <AdminPageHeader
        title={request.reference}
        description={`${request.planNameSnapshot} · ${formatPlanPrice(request.amountMinorUnits, request.currencyCode)}`}
        eyebrow={
          <Link className="admin-link" to="/admin/subscriptions">
            Subscriptions
          </Link>
        }
        actions={
          <span className={`admin-badge admin-badge-${REQUEST_STATUS_TONE[request.status]}`}>
            {REQUEST_STATUS_LABELS[request.status]}
          </span>
        }
      />

      <div className="admin-record-grid">
        <div className="admin-record-main">
          <section className="admin-card">
            <h2 className="admin-card-label">Request</h2>
            <dl className="admin-meta-grid">
              <div>
                <dt>Customer</dt>
                <dd>{request.customerEmail}</dd>
              </div>
              <div>
                <dt>Host</dt>
                <dd>{request.profileName}</dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>{request.planNameSnapshot}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                {/* The amount as it was quoted. A later price change does not
                    reach back into a request somebody already made. */}
                <dd>{formatPlanPrice(request.amountMinorUnits, request.currencyCode)}</dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>{CHANNEL_LABELS[request.channel]}</dd>
              </div>
              <div>
                <dt>Requested</dt>
                <dd>{formatDateTime(request.createdAt)}</dd>
              </div>
              <div>
                <dt>Confirmed</dt>
                <dd>{request.confirmedAt ? formatDateTime(request.confirmedAt) : "Not yet"}</dd>
              </div>
            </dl>
          </section>

          <section className="admin-card">
            <h2 className="admin-card-label">Actions</h2>
            {settled ? (
              <p className="admin-hint">
                This subscription is confirmed. The customer can claim it on their next call, and the call it was
                requested from stays ended.
              </p>
            ) : (
              <p className="admin-hint">
                Confirming grants access for one call. The call this request came from has already ended and is never
                resumed.
              </p>
            )}

            <div className="admin-card-actions">
              <button
                type="button"
                className="admin-button admin-button-primary"
                disabled={busy || settled}
                onClick={() => setPending("confirm")}
              >
                Confirm Subscription
              </button>
              <button
                type="button"
                className="admin-button admin-button-secondary"
                disabled={busy || settled || request.status === "reviewing"}
                onClick={() => void markReviewing()}
              >
                Mark as Reviewing
              </button>
              <button
                type="button"
                className="admin-button admin-button-danger"
                disabled={busy || settled}
                onClick={() => setPending("reject")}
              >
                Reject
              </button>
            </div>
          </section>
        </div>

        <aside className="admin-record-side">
          <section className="admin-card">
            <h2 className="admin-card-label">Customer care</h2>
            <p className="admin-hint">
              {request.channel === "in_app"
                ? "This customer chose in-app support, so there should be a conversation to read."
                : "This customer was sent to WhatsApp. Any in-app messages appear here too."}
            </p>
            <OpenConversationLink resolve={openConversation} />
          </section>

          <section className="admin-card">
            <h2 className="admin-card-label">Call session</h2>
            <p className="admin-hint">The call whose checkpoint asked for this subscription.</p>
            <Link className="admin-link" to={`/admin/sessions/${request.sessionId}`}>
              View call session
            </Link>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={pending === "confirm"}
        title="Confirm this subscription?"
        confirmLabel="Confirm Subscription"
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      >
        <p>
          {request.customerEmail} will be able to start one new call under {request.planNameSnapshot}. Only confirm this
          once you have seen the payment.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending === "reject"}
        title="Reject this request?"
        confirmLabel="Reject request"
        destructive
        busy={busy}
        onConfirm={() => void reject()}
        onCancel={() => setPending(null)}
      >
        <p>
          The request will be marked as needing attention and no access will be granted. The customer can still reach
          you in customer care.
        </p>
      </ConfirmDialog>
    </>
  );
}

/**
 * A link to the customer's thread, resolved on demand.
 *
 * The conversation id is not always on the request — a customer who wrote in
 * before choosing a plan already had a thread — so it is looked up by email when
 * it has to be, rather than guessed at.
 */
function OpenConversationLink({ resolve }: { resolve: () => Promise<{ id: string } | null> }) {
  const [state, setState] = useState<"idle" | "looking" | "missing">("idle");
  const [conversationId, setConversationId] = useState<string | null>(null);

  if (conversationId) {
    return (
      <Link className="admin-button admin-button-secondary" to={`/admin/support/${conversationId}`}>
        Open conversation
      </Link>
    );
  }

  if (state === "missing") return <p className="admin-hint">No conversation has been started yet.</p>;

  return (
    <button
      type="button"
      className="admin-button admin-button-secondary"
      disabled={state === "looking"}
      onClick={() => {
        setState("looking");
        void resolve()
          .then((conversation) => {
            if (conversation) {
              setConversationId(conversation.id);
              setState("idle");
              return;
            }
            setState("missing");
          })
          .catch((error: unknown) => {
            logDiagnostic("request-conversation", error);
            setState("missing");
          });
      }}
    >
      {state === "looking" ? "Finding conversation…" : "Find conversation"}
    </button>
  );
}

export default SubscriptionRequestDetailPage;
