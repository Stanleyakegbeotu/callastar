import { useState } from "react";
import { Link } from "react-router-dom";

import { formatDateTime } from "@/lib/utils";
import type { SubscriptionRequestStatus, SupportChannel } from "@/services/subscriptions/types";

import { EmptyState } from "../components/EmptyState";
import { useSubscriptionRequests } from "../hooks/useCrmData";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { CHANNEL_LABELS, REQUEST_STATUS_LABELS, REQUEST_STATUS_TONE, formatPlanPrice } from "./subscriptionInsights";

const STATUS_FILTERS: { value: SubscriptionRequestStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "awaiting_payment", label: "Awaiting payment" },
  { value: "proof_submitted", label: "Proof submitted" },
  { value: "reviewing", label: "Reviewing" },
  { value: "confirmed", label: "Confirmed" },
  { value: "needs_attention", label: "Needs attention" },
];

/**
 * Admin → Subscriptions.
 *
 * Every access request a customer has made, newest first. The amount shown is
 * the one snapshotted when the request was created — editing a plan price later
 * must never change what somebody was asked to pay.
 */
export function SubscriptionRequestsPage() {
  const [status, setStatus] = useState<SubscriptionRequestStatus | "all">("all");
  const [channel, setChannel] = useState<SupportChannel | "all">("all");
  const { data: requests, loading, error } = useSubscriptionRequests({ status, channel });

  return (
    <>
      <AdminPageHeader
        title="Subscriptions"
        description="Access requests from customers, and the payments waiting to be confirmed."
        actions={
          <Link className="admin-button admin-button-secondary" to="/admin/subscriptions/plans">
            Manage plans
          </Link>
        }
      />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="admin-toolbar">
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

        <div className="admin-select-group">
          <label htmlFor="request-channel">Channel</label>
          <select
            id="request-channel"
            className="admin-input admin-select"
            value={channel}
            onChange={(event) => setChannel(event.target.value as SupportChannel | "all")}
          >
            <option value="all">All channels</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="in_app">In-app chat</option>
          </select>
        </div>
      </div>

      {loading ? (
        <p className="admin-hint">Loading requests…</p>
      ) : requests.length === 0 ? (
        <EmptyState
          title="No subscription requests"
          description="When a customer chooses an access plan during a call, their request appears here for you to confirm."
        />
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Customer</th>
                <th scope="col">Plan</th>
                <th scope="col">Amount</th>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">Requested</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td data-label="Reference">
                    <Link className="admin-link" to={`/admin/subscriptions/${request.id}`}>
                      <code className="admin-callid-code">{request.reference}</code>
                    </Link>
                  </td>
                  <td data-label="Customer">
                    <span className="admin-stacked">
                      <strong>{request.customerEmail}</strong>
                      <small>{request.profileName}</small>
                    </span>
                  </td>
                  <td data-label="Plan">{request.planNameSnapshot}</td>
                  <td data-label="Amount">{formatPlanPrice(request.amountMinorUnits, request.currencyCode)}</td>
                  <td data-label="Channel">{CHANNEL_LABELS[request.channel]}</td>
                  <td data-label="Status">
                    <span className={`admin-badge admin-badge-${REQUEST_STATUS_TONE[request.status]}`}>
                      {REQUEST_STATUS_LABELS[request.status]}
                    </span>
                  </td>
                  <td data-label="Requested">{formatDateTime(request.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default SubscriptionRequestsPage;
