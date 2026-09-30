import { SESSION_STATUS_LABELS, SESSION_STATUS_TONE } from "@/services/admin/sessionInsights";
import type { CallType } from "@/types/call";
import type { CallSessionStatus, ProfileReadiness, ProfileStatus } from "@/services/admin/types";

const STATUS_LABELS: Record<ProfileStatus, string> = { active: "Active", inactive: "Inactive" };

const READINESS_LABELS: Record<ProfileReadiness, string> = {
  ready: "Ready",
  incomplete: "Setup incomplete",
  inactive: "Inactive",
};

/**
 * Status is carried by the label as well as the colour, so it still reads
 * correctly without colour vision.
 */
export function StatusBadge({ status }: { status: ProfileStatus }) {
  return <span className={`admin-badge admin-badge-${status}`}>{STATUS_LABELS[status]}</span>;
}

export function ReadinessBadge({ readiness }: { readiness: ProfileReadiness }) {
  return <span className={`admin-badge admin-badge-${readiness}`}>{READINESS_LABELS[readiness]}</span>;
}

export function MediaBadge({ present }: { present: boolean }) {
  return (
    <span className={`admin-badge ${present ? "admin-badge-ready" : "admin-badge-missing"}`}>
      {present ? "Ready" : "Missing"}
    </span>
  );
}

/** Call lifecycle state. The label carries the meaning; colour only supports it. */
export function SessionStatusBadge({ status }: { status: CallSessionStatus }) {
  return <span className={`admin-badge admin-badge-${SESSION_STATUS_TONE[status]}`}>{SESSION_STATUS_LABELS[status]}</span>;
}

export function CallTypeBadge({ callType }: { callType: CallType }) {
  return (
    <span className="admin-badge admin-badge-type">{callType === "video" ? "Video" : "Audio"}</span>
  );
}

export default StatusBadge;
