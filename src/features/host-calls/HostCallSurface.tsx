import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { AudioCallCanvas } from "@/features/calls/components/AudioCallCanvas";
import { LiveCallCanvas } from "@/features/calls/components/LiveCallCanvas";
import { ConnectingOverlay } from "@/features/calls/components/CallOverlays";
import { useOrientationGuard } from "@/features/calls/hooks/useOrientationGuard";
import { useCallTimer } from "@/features/call-session/hooks/useCallTimer";

import { useHostCall } from "./HostCallProvider";
import { IncomingCallScreen } from "./components/IncomingCallScreen";
import { SourceSelectionScreen } from "./components/SourceSelectionScreen";

/**
 * Everything live calling puts on an operator's screen.
 *
 * Rendered once, above the admin routes, so a call arrives wherever the operator
 * is working. It renders nothing at all when no call is happening, which is most
 * of the time — the provider holds the connection, this only draws.
 */
export function HostCallSurface() {
  const { t } = useTranslation();
  const host = useHostCall();
  const { state, profile } = host;

  const isVideo = state.call?.callType === "video";
  const seconds = useCallTimer(state.startedAt, state.phase === "in_call" && state.startedAt !== null);

  // A video call is portrait-only on this side too. Armed only while a video call
  // is actually up, so turning a phone sideways on the dashboard does nothing.
  const landscape = useOrientationGuard(
    isVideo === true && (state.phase === "connecting" || state.phase === "in_call"),
  );

  if (state.phase === "incoming" && state.call) {
    return (
      <IncomingCallScreen
        call={state.call}
        profileName={profile?.displayName ?? ""}
        mustAnswerOnMobile={host.mustAnswerOnMobile}
        onAnswer={host.answer}
        onDecline={host.decline}
      />
    );
  }

  if (state.phase === "source_selection" && state.call) {
    return (
      <SourceSelectionScreen
        callerName={state.call.caller.displayName}
        options={host.sourceOptions}
        deadline={state.sourceDeadline}
        onChoose={host.chooseSource}
      />
    );
  }

  if ((state.phase === "accepting" || state.phase === "connecting") && state.call) {
    // Between answering and media flowing. Shown full-screen rather than as a
    // corner spinner: the operator is in a call, not browsing.
    return (
      <div className="host-connecting">
        <ConnectingOverlay label={t("hostCall.connectingCaller")} />
      </div>
    );
  }

  if (state.phase === "in_call" && state.call) {
    // Audio gets its own surface here too, so the operator sees the same product
    // the caller does rather than a video call with nothing in it.
    if (!isVideo) {
      return (
        <AudioCallCanvas
          remoteName={state.call.caller.displayName}
          remoteStream={host.remoteStream}
          seconds={seconds}
          micEnabled={host.micEnabled}
          canSelectOutput={false}
          reconnecting={false}
          onToggleMic={host.toggleMic}
          onEnd={host.hangup}
        />
      );
    }

    return (
      <LiveCallCanvas
        remoteName={state.call.caller.displayName}
        remoteShortName={state.call.caller.displayName.split(/\s+/)[0] ?? state.call.caller.displayName}
        localStream={host.localStream}
        remoteStream={host.remoteStream}
        hasRemoteMedia={host.hasRemoteMedia}
        seconds={seconds}
        micEnabled={host.micEnabled}
        cameraEnabled={host.cameraEnabled}
        canSwitchCamera={host.canSwitchCamera}
        showCameraControls={isVideo === true}
        reconnecting={false}
        landscape={landscape}
        onToggleMic={host.toggleMic}
        onToggleCamera={host.toggleCamera}
        onSwitchCamera={() => void host.switchCamera()}
        onEnd={host.hangup}
      />
    );
  }

  /**
   * What happened to the last call.
   *
   * Dismissable rather than timed, and the wording follows the outcome: an
   * operator whose caller was paywalled is told exactly that, because "the
   * connection failed" would send them looking for a fault that never existed.
   */
  if (state.outcome) {
    const copy = (() => {
      switch (state.outcome.kind) {
        case "subscription_required":
          return t("hostCall.endedSubscription");
        case "cancelled":
          return t("hostCall.endedCancelled");
        case "declined":
          return t("hostCall.endedDeclined");
        case "no_answer":
          return t("hostCall.endedNoAnswer");
        case "failed":
          return state.error ?? t("hostCall.endedFailed");
        default:
          return null;
      }
    })();

    return (
      <div className="host-outcome" role="status" aria-live="polite">
        <div className="host-outcome-card">
          <span className="host-outcome-icon">
            <Icon name={state.outcome.kind === "failed" ? "bolt" : "check"} className="size-5" />
          </span>
          <div className="host-outcome-text">
            <strong>{t("hostCall.endedTitle")}</strong>
            {copy && <span>{copy}</span>}
          </div>
          <button
            type="button"
            className="host-outcome-close"
            onClick={host.dismissOutcome}
            aria-label={t("common.close")}
          >
            <Icon name="close" className="size-4" />
          </button>
        </div>
      </div>
    );
  }

  return null;
}

export default HostCallSurface;
