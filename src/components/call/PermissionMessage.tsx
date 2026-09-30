import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import type { MediaErrorInfo, MediaPermissionState } from "@/types/media";

interface PermissionMessageProps {
  error: MediaErrorInfo;
  permission: MediaPermissionState;
  onRetry: () => void;
  onBack: () => void;
  onGoHome?: () => void;
  busy?: boolean;
}

/**
 * Terminal state for a call that could not get its devices. Always offers a way
 * forward, so a denied prompt can never leave the caller on a spinner.
 */
export function PermissionMessage({ error, permission, onRetry, onBack, onGoHome, busy = false }: PermissionMessageProps) {
  // A denial the browser has remembered cannot be re-prompted from script; the
  // caller has to change it in site settings first.
  const blockedInSettings = error.kind === "permission_denied" && permission === "denied";

  return (
    <main className="status-screen">
      <div className="status-brand">
        <CallaStarLogo />
      </div>
      <div className="status-content" role="alert">
        <div className="camera-off-icon media-error-icon">
          <Icon name="cameraOff" className="size-8" />
        </div>
        <h1 className="status-title">{error.title}</h1>
        <p className="status-copy">{error.message}</p>
        {blockedInSettings && (
          <p className="status-hint">
            Your browser is remembering an earlier block. Open the camera icon in the address bar, or your browser
            site settings, to allow access for this site.
          </p>
        )}
        <div className="status-actions">
          {error.retryable && (
            <Button onClick={onRetry} disabled={busy} withArrow={false}>
              {busy ? "Requesting access…" : "Try Again"}
            </Button>
          )}
          <Button variant="secondary" withArrow={false} onClick={onBack}>
            Back to call details
          </Button>
          {onGoHome && (
            <Button variant="secondary" withArrow={false} onClick={onGoHome}>
              Return home
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}

export default PermissionMessage;
