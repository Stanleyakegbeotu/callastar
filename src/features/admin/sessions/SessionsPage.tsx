import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { matchesSessionSearch, rangeStart, type SessionDateRange } from "@/services/admin/sessionInsights";
import type { CallSessionStatus } from "@/services/admin/types";
import type { CallType } from "@/types/call";

import { EmptyState } from "../components/EmptyState";
import { useCallSessions, useProfiles } from "../hooks/useAdminData";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { SessionTable } from "./SessionTable";

const STATUSES: { value: CallSessionStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "ended", label: "Ended" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed", label: "Failed" },
];

const RANGES: { value: SessionDateRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

/**
 * Call history for the whole workspace.
 *
 * Status, type, host and date narrow the query through the repository; search
 * and sort run over the returned rows, which is ample for local volumes and
 * keeps the filter surface small.
 */
export function SessionsPage() {
  // The host filter arrives as a query parameter from a profile record, so the
  // link from "View all calls" is shareable and survives a reload.
  const [params, setParams] = useSearchParams();
  const profileId = params.get("profileId") ?? "all";

  const [status, setStatus] = useState<CallSessionStatus | "all">("all");
  const [callType, setCallType] = useState<CallType | "all">("all");
  const [range, setRange] = useState<SessionDateRange>("all");
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<"newest" | "oldest">("newest");

  const since = useMemo(() => rangeStart(range), [range]);
  const { data: sessions, loading, error } = useCallSessions({ status, callType, profileId, since });
  const { data: profiles } = useProfiles();

  const visible = useMemo(() => {
    const matched = sessions.filter((session) => matchesSessionSearch(session, search));
    return order === "newest" ? matched : [...matched].reverse();
  }, [order, search, sessions]);

  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const hasFilters = status !== "all" || callType !== "all" || range !== "all" || profileId !== "all" || search !== "";

  const setProfileFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("profileId");
    else next.set("profileId", value);
    setParams(next, { replace: true });
  };

  return (
    <>
      <AdminPageHeader title="Call sessions" description="Review call activity and connection history." />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="admin-toolbar">
        <div className="admin-search">
          <label className="admin-visually-hidden" htmlFor="session-search">
            Search call sessions
          </label>
          <input
            id="session-search"
            className="admin-input"
            type="search"
            placeholder="Search caller, email, phone or host"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="admin-filters" role="group" aria-label="Filter by status">
          {STATUSES.map((option) => (
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

      <div className="admin-toolbar admin-toolbar-secondary">
        <div className="admin-select-group">
          <label htmlFor="session-type">Type</label>
          <select
            id="session-type"
            className="admin-input admin-select"
            value={callType}
            onChange={(event) => setCallType(event.target.value as CallType | "all")}
          >
            <option value="all">All types</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
          </select>
        </div>

        <div className="admin-select-group">
          <label htmlFor="session-profile">Host</label>
          <select
            id="session-profile"
            className="admin-input admin-select"
            value={profileId}
            onChange={(event) => setProfileFilter(event.target.value)}
          >
            <option value="all">All hosts</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="admin-select-group">
          <label htmlFor="session-range">Period</label>
          <select
            id="session-range"
            className="admin-input admin-select"
            value={range}
            onChange={(event) => setRange(event.target.value as SessionDateRange)}
          >
            {RANGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="admin-select-group">
          <label htmlFor="session-order">Sort</label>
          <select
            id="session-order"
            className="admin-input admin-select"
            value={order}
            onChange={(event) => setOrder(event.target.value as "newest" | "oldest")}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>

      {selectedProfile && (
        <p className="admin-filter-note">
          Showing calls for <strong>{selectedProfile.displayName}</strong>.{" "}
          <button type="button" className="admin-link admin-link-button" onClick={() => setProfileFilter("all")}>
            Show all hosts
          </button>
        </p>
      )}

      {loading ? (
        <p className="admin-hint">Loading call sessions…</p>
      ) : visible.length === 0 ? (
        <EmptyState
          title={hasFilters ? "No matching call sessions" : "No call sessions yet"}
          description={
            hasFilters
              ? "Try a different search term, status or period."
              : "Calls made through CallaStar will appear here."
          }
          action={
            hasFilters ? undefined : (
              <Link className="admin-button admin-button-secondary" to="/">
                Open CallaStar
              </Link>
            )
          }
        />
      ) : (
        <SessionTable sessions={visible} />
      )}
    </>
  );
}

export default SessionsPage;
