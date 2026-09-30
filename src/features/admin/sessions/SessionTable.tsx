import { Link } from "react-router-dom";

import { formatDateTime, formatDuration } from "@/lib/utils";
import { describeSourceKind, getCallDuration } from "@/services/admin/sessionInsights";
import type { CallSessionRecord } from "@/services/admin/types";

import { CallTypeBadge, SessionStatusBadge } from "../components/StatusBadge";

interface SessionTableProps {
  sessions: CallSessionRecord[];
  /** Hide the host column where the surrounding page is already about one host. */
  showHost?: boolean;
  compact?: boolean;
}

/** A dash, not a zero: a call that never connected has no duration to report. */
export function SessionDuration({ session }: { session: CallSessionRecord }) {
  const seconds = getCallDuration(session);
  if (seconds === null) return <span aria-label="No duration, this call never connected">—</span>;
  return <span>{formatDuration(seconds)}</span>;
}

/**
 * Call history.
 *
 * One table serves desktop and mobile: below the tablet breakpoint the CSS
 * restacks each row into a card, with every cell labelled by its header. Only
 * session and profile metadata is read — no media is touched to draw history.
 */
export function SessionTable({ sessions, showHost = true, compact = false }: SessionTableProps) {
  return (
    <div className="admin-table-wrap">
      <table className={`admin-table admin-session-table ${compact ? "is-compact" : ""}`.trim()}>
        <thead>
          <tr>
            <th scope="col">Caller</th>
            {showHost && <th scope="col">Host</th>}
            <th scope="col">Type</th>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
            <th scope="col">Started</th>
            {!compact && <th scope="col">Connected</th>}
            <th scope="col">Duration</th>
            <th scope="col">
              <span className="admin-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td data-label="Caller">
                <Link className="admin-stacked admin-session-link" to={`/admin/sessions/${session.id}`}>
                  <strong>{session.caller.fullName || "Unknown caller"}</strong>
                  {session.caller.email && <small>{session.caller.email}</small>}
                </Link>
              </td>
              {showHost && (
                <td data-label="Host">
                  <Link className="admin-link" to={`/admin/profiles/${session.profileId}`}>
                    {session.profileName}
                  </Link>
                </td>
              )}
              <td data-label="Type">
                <CallTypeBadge callType={session.callType} />
              </td>
              {/* What the caller actually saw or heard. "—" until a call
                  connected, because nothing was settled before then. */}
              <td data-label="Source">{describeSourceKind(session.sourceKind)}</td>
              <td data-label="Status">
                <SessionStatusBadge status={session.status} />
              </td>
              <td data-label="Started">{formatDateTime(session.createdAt)}</td>
              {!compact && (
                <td data-label="Connected">{session.connectedAt ? formatDateTime(session.connectedAt) : "—"}</td>
              )}
              <td data-label="Duration">
                <SessionDuration session={session} />
              </td>
              <td data-label="Actions" className="admin-row-actions">
                <Link className="admin-button admin-button-ghost" to={`/admin/sessions/${session.id}`}>
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default SessionTable;
