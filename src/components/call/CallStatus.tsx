import { formatDuration } from "@/lib/utils";

interface CallStatusProps {
  displayName: string;
  /** Seconds since the call became active. */
  seconds: number;
  status?: "connecting" | "ringing" | "active";
}

/**
 * Top-left overlay on a call: who you are with, and how long it has been.
 * Drawn exactly as the prototype - no badges competing with the person.
 */
export function CallStatus({ displayName, seconds, status = "active" }: CallStatusProps) {
  const detail =
    status === "connecting" ? "Connecting…" : status === "ringing" ? "Ringing…" : formatDuration(seconds);

  return (
    <div className="call-top">
      <p className="call-person-name">{displayName}</p>
      <p className="call-person-detail">
        {status === "active" && <span className="admin-visually-hidden">Call duration </span>}
        {detail}
      </p>
    </div>
  );
}

export default CallStatus;
