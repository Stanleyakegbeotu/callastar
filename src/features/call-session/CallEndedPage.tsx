import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatDuration } from "@/lib/utils";
import type { HostPreview } from "@/types/host";

interface CallEndedPageProps {
  host: HostPreview;
  /** A call that never connected was cancelled, and has no duration to show. */
  outcome: "ended" | "cancelled";
  durationSeconds: number | null;
  onStartNewCall: () => void;
  onGoHome: () => void;
}

/**
 * The end of a call.
 *
 * Deliberately plain: it confirms what happened, how long it lasted if it
 * connected, and offers the two things anyone wants next. A call that was
 * hung up before it connected never shows a fabricated duration.
 */
export function CallEndedPage({ host, outcome, durationSeconds, onStartNewCall, onGoHome }: CallEndedPageProps) {
  const connected = outcome === "ended" && durationSeconds !== null;

  return (
    <main className="status-screen">
      <div className="status-brand">
        <CallaStarLogo />
      </div>
      <div className="status-content">
        <Avatar src={host.avatarUrl} alt="" />
        <h1 className="status-title" role="status">
          {outcome === "cancelled" ? "Call cancelled" : "Call ended"}
        </h1>
        <p className="status-copy">
          {connected
            ? `Your call with ${host.displayName}.`
            : `Your call with ${host.displayName} ended before it connected.`}
        </p>

        {connected && (
          <p className="call-ended-duration">
            <span className="admin-visually-hidden">Call duration </span>
            {formatDuration(durationSeconds)}
          </p>
        )}

        <div className="secure-pill">
          <Icon name="lock" className="size-4" />
          Camera and microphone released
        </div>

        <div className="status-actions">
          <Button onClick={onGoHome} withArrow={false}>
            Return home
          </Button>
          <Button variant="secondary" withArrow={false} onClick={onStartNewCall}>
            Start another call
          </Button>
        </div>
      </div>
    </main>
  );
}

export default CallEndedPage;
