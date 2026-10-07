import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";

import { Icon } from "@/components/ui/Icon";

import { PermissionMessage } from "@/components/call/PermissionMessage";
import { config, isLiveCallingConfigured } from "@/lib/config";
import { logDiagnostic } from "@/lib/utils";
import { notifyAdmin } from "@/services/notifications/repository";
import { previewAccessRepository } from "@/services/access/previewAccess";
import { createSessionId } from "@/services/callSession";
import { subscriptionRepository } from "@/services/subscriptions/repository";
import type { SubscriptionPlan, SubscriptionRequest, SupportChannel } from "@/services/subscriptions/types";
import { useCallSession } from "@/state/CallSessionContext";
import type { MediaErrorInfo } from "@/types/media";

import type { CallEndReason } from "@/services/signaling";
import { AudioCallCanvas } from "@/features/calls/components/AudioCallCanvas";
import { LiveCallCanvas } from "@/features/calls/components/LiveCallCanvas";

import { CallOutcomeScreen } from "./live/CallOutcomeScreen";
import { CallPermissionScreen } from "./live/CallPermissionScreen";
import { LiveRingingScreen } from "./live/LiveRingingScreen";
import { useLiveGuestCall } from "./hooks/useLiveGuestCall";
import { useCallTimer } from "./hooks/useCallTimer";

import { ActiveAudioCallPage } from "./ActiveAudioCallPage";
import { ActiveVideoCallPage } from "./ActiveVideoCallPage";
import { CallEndedPage } from "./CallEndedPage";
import { ConnectingPage } from "./ConnectingPage";
import { useSimulatedCallFlow } from "./hooks/useCallFlow";
import { useCameraPermission } from "./hooks/useCameraPermission";
import { useLocalMedia } from "./hooks/useLocalMedia";
import { useCallAccessGate } from "./hooks/useCallAccessGate";
import { useRemoteVideo } from "./hooks/useRemoteVideo";
import { useRingbackTone } from "./hooks/useRingbackTone";
import { SubscriptionAccessScreen } from "./subscription/SubscriptionAccessScreen";
import { SubscriptionCheckpoint } from "./subscription/SubscriptionCheckpoint";
import { SupportOverlay } from "@/features/support/SupportOverlay";
import { useWhatsappSupportNumber } from "@/features/support/hooks/useWhatsappSupportNumber";
import { useSessionRecorder } from "./hooks/useSessionRecorder";
import { useCallEvidenceScreenshot } from "./hooks/useCallEvidenceScreenshot";
import { useSessionLimit } from "./hooks/useSessionLimit";
import { SessionCompletePage } from "./SessionCompletePage";

const FALLBACK_MEDIA_ERROR: MediaErrorInfo = {
  kind: "unknown",
  title: "We could not start your call",
  message: "Something went wrong while preparing your call. Please try again.",
  retryable: true,
};

/**
 * Container for `/call/:sessionId`.
 *
 * Owns the camera and microphone for the whole call and renders whichever screen
 * the session status calls for. The individual screens hold no call logic, so
 * there is one place where devices are acquired, released and re-requested.
 */
export function CallSessionRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // A retry, or Start New Call, lands here with a fresh id in the URL before
  // state knows about it.
  const retryRequested = (location.state as { retry?: boolean } | null)?.retry === true;
  const { session, dispatch } = useCallSession();
  /**
   * Which of the two modes this call is running in.
   *
   * Deliberately one flag, read in every branch below, so the live path and the
   * legacy simulated path are never accidentally mixed. Demo mode is a simulation
   * by definition and stays on the old path.
   */
  const liveMode = isLiveCallingConfigured;
  const media = useLocalMedia(session.type);
  // These three are stable across renders; the effects below depend on them
  // rather than on the controller object.
  const { request: requestMedia, stop: stopMedia, status: mediaStatus } = media;
  const host = session.host;
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportChannel, setSupportChannel] = useState<SupportChannel>("in_app");

  // The remote clip is only fetched once the call is actually active.
  const remote = useRemoteVideo(host, session.status === "active", session.type);
  const hasUploadedFreeVideoPreview =
    !liveMode &&
    session.type === "video" &&
    session.access === null &&
    Boolean(host?.remoteVideoRef) &&
    remote.status === "ready" &&
    remote.url !== null;

  // Only worth querying while the answer affects what we show.
  const permission = useCameraPermission(session.status === "failed");

  // Audible feedback that the call is going out. Stops the moment the other
  // side answers, which is the same moment the timer starts.
  useRingbackTone(session.status === "connecting" || session.status === "ringing");

  /**
   * With no signalling service configured there is no host to ring, so the
   * legacy simulated pacing stands in. A live call is paced by signalling events
   * instead, and this does nothing there.
   */
  useSimulatedCallFlow(session.status, dispatch, !liveMode);

  const endedDuration =
    session.startedAt !== null && session.endedAt !== null
      ? Math.floor((session.endedAt - session.startedAt) / 1000)
      : null;
  const sessionMatches = session.id !== "" && session.id === sessionId;

  // Everything that happens to this call is persisted here, exactly once.
  const { record } = useSessionRecorder({
    session,
    sessionMatches,
    micEnabled: media.micEnabled,
    cameraEnabled: media.cameraEnabled,
    mediaReady: mediaStatus === "ready",
  });

  const { number: whatsappNumber } = useWhatsappSupportNumber();

  /**
   * No subscription: the call is over.
   *
   * Everything that makes a call a call is released here, in one step, before
   * anything is drawn — every local track, so the browser's camera indicator
   * goes out; the remote media, which the `active` flag below stops fetching and
   * whose object URL its own hook revokes; the timer, which stops with the
   * screen; and the session record, which END_CALL finalises. The session is
   * final from this point, and nothing in the access flow can return it to
   * active: END_CALL is not an allowed transition out of `ended`.
   */
  const endForSubscription = useCallback(() => {
    record("subscription-required", "subscription_required");
    // The one place a preview is spent. Not on opening the app, not on dialling,
    // not on a denied camera — only here, where the check actually decided that
    // a subscription is needed.
    if (host) {
      void previewAccessRepository
        .markSubscriptionRequired(host.id)
        .catch((error: unknown) => logDiagnostic("preview-access", error));
    }
    stopMedia();
    dispatch({ type: "END_CALL" });
  }, [dispatch, host, record, stopMedia]);

  const onRequestCreated = useCallback(
    (request: SubscriptionRequest) => {
      record(`subscription-requested-${request.id}`, "subscription_requested", {
        reference: request.reference,
        plan: request.planNameSnapshot,
        amountMinorUnits: request.amountMinorUnits,
        currencyCode: request.currencyCode,
        channel: request.channel,
      });
      notifyAdmin({
        type: "subscription_requested",
        title: `${request.planNameSnapshot} access requested`,
        body: `${request.customerEmail} is waiting for ${request.reference} to be confirmed.`,
        entityKind: "subscription_request",
        entityId: request.id,
      });
    },
    [record],
  );

  const onCheckStarted = useCallback(() => record("subscription-check", "subscription_check_started"), [record]);
  const onAccessGranted = useCallback(
    () => record("subscription-granted", "subscription_access_granted"),
    [record],
  );

  /**
   * Access is a separate concern from the call lifecycle: the call stays
   * `active` — with its media playing — while this decides whether it may
   * continue at all.
   */
  const gate = useCallAccessGate({
    sessionId: session.id,
    profileId: host?.id ?? "",
    profileName: host?.displayName ?? "",
    customerEmail: session.caller.email,
    armed:
      session.status === "active" &&
      remote.status !== "loading" &&
      host !== null &&
      !hasUploadedFreeVideoPreview,
    // A call authorised by a Subscription Access ID never runs the unpaid gate.
    authorized: session.access !== null,
    whatsappNumber,
    onAccessRequired: endForSubscription,
    onCheckStarted,
    onAccessGranted,
    onRequestCreated,
  });

  /**
   * The real call.
   *
   * All of the signalling and WebRTC lives in this hook. `enabled` is what keeps
   * the two modes apart: with no service configured it does nothing at all and the
   * simulated pacing above runs instead.
   */
  const [endedByHost, setEndedByHost] = useState(false);
  const live = useLiveGuestCall({
    session,
    dispatch,
    localStream: media.stream,
    enabled: liveMode,
    onEndReason: useCallback((reason: CallEndReason) => {
      // Remembered so the ended screen can say who hung up.
      if (reason === "hangup" || reason === "declined") setEndedByHost(true);
    }, []),
  });

  /**
   * The call timer, counting from the moment media actually connected.
   *
   * Kept running through `reconnecting`: the conversation did not restart, so
   * neither does the clock.
   */
  const liveSeconds = useCallTimer(
    session.startedAt,
    (session.status === "active" || session.status === "reconnecting") && session.startedAt !== null,
  );

  useCallEvidenceScreenshot({
    session,
    sessionMatches,
    liveMode,
    rtcConnected: live.phase === "connected",
    localStream: media.stream,
  });

  /**
   * What a brand-new session does first.
   *
   * On the live path it RESOLVES before anything else: the Call ID, the profile
   * being Active, and somebody actually being there to answer. Asking for a
   * camera first would spend a permission decision on a call that may not be
   * possible — so the device prompt comes after this, never before.
   *
   * The simulated path has no host to check, so it goes straight to devices.
   */
  useEffect(() => {
    if (!sessionMatches || session.status !== "preparing") return;

    if (liveMode) {
      dispatch({ type: "START_RESOLVING" });
      return;
    }

    dispatch({ type: "REQUEST_PERMISSIONS" });
  }, [dispatch, session.status, sessionMatches]);

  /**
   * One device request per attempt. Every dependency here is stable or a
   * primitive, so this runs once per attempt rather than once per render, and
   * the cleanup drops the result of a request this screen no longer owns.
   */
  useEffect(() => {
    if (!sessionMatches || session.status !== "requesting_permissions") return;

    let cancelled = false;
    void requestMedia().then((result) => {
      if (cancelled) return;
      if (result.outcome === "granted") {
        dispatch({ type: "PERMISSIONS_GRANTED" });
        // The simulated path has no invitation to send, so devices being ready
        // is the whole of "the call is starting". On the live path the
        // orchestrator sends `call.invite` here instead, and the reducer
        // deliberately leaves the next step to whoever is driving.
        if (!liveMode) dispatch({ type: "START_CONNECTING" });
      } else if (result.outcome === "failed") {
        dispatch({ type: "PERMISSIONS_DENIED", error: result.error.message });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [dispatch, requestMedia, session.attempt, session.status, sessionMatches]);

  /**
   * Coming back to a live session that no longer has its media — a forward
   * button, or a remount after the hardware was released — restarts the attempt
   * rather than resuming a call with a dead camera.
   */
  useEffect(() => {
    if (!sessionMatches) return;
    if (mediaStatus !== "idle") return;
    if (session.status !== "connecting" && session.status !== "ringing" && session.status !== "active") return;

    dispatch({ type: "START_SESSION", id: session.id });
  }, [dispatch, mediaStatus, session.id, session.status, sessionMatches]);

  const chooseChannel = useCallback(
    (channel: SupportChannel) => {
      setSupportChannel(channel);
      setSupportOpen(true);
    },
    [],
  );

  const openSupportChat = useCallback(() => {
    setSupportChannel("in_app");
    setSupportOpen(true);
  }, []);

  const confirmSubscription = useCallback(
    (channel: SupportChannel, email: string) => gate.startPayment(channel, email),
    [gate.startPayment],
  );

  const selectSupportPackage = useCallback(async (plan: SubscriptionPlan) => {
    const request = gate.request;
    if (request && request.status !== "confirmed" && request.status !== "cancelled") {
      const cancelled = await subscriptionRepository.cancelRequest(request.id);
      if (!cancelled) throw new Error("The current payment request could not be cancelled.");
    }
    gate.choosePlan(plan);
  }, [gate.choosePlan, gate.request]);

  const endCall = useCallback(() => {
    // Release the hardware first so the camera indicator goes out immediately.
    stopMedia();
    dispatch({ type: "END_CALL" });
  }, [dispatch, stopMedia]);

  const onRemoteEnded = useCallback(() => {
    record("remote-media-ended", "remote_media_ended", {
      endedBeforeSubscriptionCheck: gate.status !== "checking",
    });
    if (hasUploadedFreeVideoPreview) gate.finishPreview();
  }, [gate.finishPreview, gate.status, hasUploadedFreeVideoPreview, record]);

  /**
   * A paid session gets exactly the length its plan sells. When the time is up
   * the call ends the same way any other call ends — every track stopped — and
   * the screen says why rather than simply going quiet.
   */
  const [limitReached, setLimitReached] = useState(false);
  const limit = useSessionLimit({
    startedAt: session.startedAt,
    minutes: session.access?.sessionDurationMinutes ?? null,
    active: session.status === "active",
    onExpire: useCallback(() => {
      record("session-limit-reached", "session_limit_reached");
      setLimitReached(true);
      stopMedia();
      dispatch({ type: "END_CALL" });
    }, [dispatch, record, stopMedia]),
  });

  /**
   * A retry is a new call attempt: a fresh id, so a session already written to
   * history is never dragged back into connecting. Start New Call takes exactly
   * the same path — it is a new call, not a resumed one.
   *
   * Only the URL changes here. React Router runs navigation in a transition, so
   * moving the session first would let this screen re-render against the old
   * address, decide the session is a stranger and send everyone home.
   */
  const startFreshCall = useCallback(() => {
    setSupportOpen(false);
    navigate(`/call/${createSessionId()}`, { replace: true, state: { retry: true } });
  }, [navigate]);

  // Adopt the id the navigation carried. The caller and host are already known,
  // so this starts the next attempt without anybody retyping anything.
  useEffect(() => {
    if (sessionMatches || !retryRequested || !sessionId || !session.host) return;
    dispatch({ type: "START_SESSION", id: sessionId });
  }, [dispatch, retryRequested, session.host, sessionId, sessionMatches]);

  // A session that does not match the URL (a refresh, or a stale link) has no
  // state to show, so start over rather than render an empty call.
  if (!sessionMatches || !host) {
    // Mid-navigation: the effect above is adopting this id, so wait one render
    // rather than treating it as an unknown session.
    if (retryRequested && session.host) return null;
    return <Navigate to="/" replace />;
  }

  const supportOverlay = supportOpen ? (
    <SupportOverlay
      caller={session.caller}
      request={gate.request}
      sessionId={session.id}
      plan={gate.selectedPlan}
      availablePlans={gate.plans}
      profileId={host?.id ?? ""}
      profileName={host?.displayName ?? ""}
      channel={supportChannel}
      whatsappNumber={gate.whatsappNumber}
      whatsappLinkFor={gate.whatsappLinkFor}
      onConfirmSubscription={confirmSubscription}
      onSelectPackage={selectSupportPackage}
      onClose={() => setSupportOpen(false)}
    />
  ) : null;

  /* ------------------------------------------------- the live calling path */

  if (liveMode) {
    switch (session.status) {
      case "preparing":
        return <ConnectingPage host={host} title={t("common.loading")} copy="" />;

      /**
       * Checking who is being called, before anything is asked of the browser.
       *
       * Once the host is confirmed available, the permission screen explains the
       * prompt that is about to appear. `getUserMedia` runs only when the caller
       * presses Continue.
       */
      case "resolving":
        return session.callAttemptId ? (
          <CallPermissionScreen
            callType={session.type}
            busy={mediaStatus === "requesting"}
            onContinue={() => dispatch({ type: "REQUEST_PERMISSIONS" })}
            onCancel={() => navigate(`/join/${session.type}`)}
          />
        ) : (
          <ConnectingPage host={host} title={t("common.loading")} copy="" />
        );

      case "requesting_permissions":
        return (
          <CallPermissionScreen
            callType={session.type}
            busy
            onContinue={() => {}}
            onCancel={() => navigate(`/join/${session.type}`)}
          />
        );

      case "inviting":
        return <LiveRingingScreen host={host} stage="requesting" onCancel={live.cancel} />;

      case "ringing":
        return <LiveRingingScreen host={host} stage="ringing" onCancel={live.cancel} />;

      case "accepted":
        return <LiveRingingScreen host={host} stage="accepted" onCancel={live.cancel} />;

      case "source_selection":
      case "negotiating":
        return <LiveRingingScreen host={host} stage="connecting" onCancel={live.cancel} />;

      case "connecting":
      case "active":
      case "reconnecting": {
        const overlay =
          session.status !== "connecting" ? (
            <>
              <SubscriptionCheckpoint gate={gate} />
              {limit.warning && session.access && (
                <p className="session-limit-notice" role="status">
                  <Icon name="clock" className="size-4" />
                  {t("sessionLimit.remaining", { plan: session.access.planName })}
                </p>
              )}
            </>
          ) : null;

        // An audio call gets its own surface. Reusing the video canvas with the
        // picture switched off would look like a video call that had failed.
        if (session.type === "audio") {
          return (
            <AudioCallCanvas
              remoteName={host.displayName}
              remoteAvatarUrl={host.avatarUrl}
              remoteStream={live.remoteStream}
              seconds={liveSeconds}
              micEnabled={media.micEnabled}
              canSelectOutput={media.canSelectAudioOutput}
              reconnecting={session.status === "reconnecting"}
              onToggleMic={media.toggleMic}
              onEnd={() => live.hangup()}
              overlay={overlay}
              checkpointVisible={gate.status === "checking"}
            />
          );
        }

        return (
          <LiveCallCanvas
            remoteName={host.displayName}
            remoteShortName={host.shortName}
            remoteAvatarUrl={host.avatarUrl}
            localStream={media.stream}
            remoteStream={live.remoteStream}
            hasRemoteMedia={live.hasRemoteMedia}
            seconds={liveSeconds}
            micEnabled={media.micEnabled}
            cameraEnabled={media.cameraEnabled}
            canSwitchCamera={media.canSwitchCamera}
            showCameraControls={session.type === "video"}
            // Real ICE trouble only. The uploaded-source fallback is a different
            // concept and lives on the simulated path.
            reconnecting={session.status === "reconnecting"}
            onToggleMic={media.toggleMic}
            onToggleCamera={media.toggleCamera}
            onSwitchCamera={() => void media.switchCamera()}
            onEnd={() => live.hangup()}
            overlay={overlay}
            checkpointVisible={gate.status === "checking"}
          />
        );
      }

      case "ending":
        return <ConnectingPage host={host} title={t("liveCall.endedTitle")} copy="" />;

      case "declined":
        return (
          <CallOutcomeScreen host={host} outcome={{ kind: "declined" }} onCallAgain={startFreshCall} onGoHome={() => navigate("/")} />
        );

      case "no_answer":
        return (
          <CallOutcomeScreen host={host} outcome={{ kind: "no_answer" }} onCallAgain={startFreshCall} onGoHome={() => navigate("/")} />
        );

      case "failed":
        // A blocked camera keeps its own dedicated screen, which explains how to
        // unblock it; everything else is a classified call outcome.
        if (session.failureReason === "permission_denied") {
          return (
            <PermissionMessage
              error={media.error ?? FALLBACK_MEDIA_ERROR}
              permission={permission}
              busy={mediaStatus === "requesting"}
              onRetry={startFreshCall}
              onBack={() => navigate(`/join/${session.type}`)}
              onGoHome={() => navigate("/")}
            />
          );
        }
        return (
          <CallOutcomeScreen
            host={host}
            outcome={{
              kind: "failure",
              reason: session.failureReason ?? "rtc_negotiation_failed",
              message: session.error,
            }}
            onCallAgain={startFreshCall}
            onGoHome={() => navigate("/")}
          />
        );

      case "ended":
        if (limitReached && session.access) {
          return (
            <SessionCompletePage
              host={host}
              planName={session.access.planName}
              durationSeconds={endedDuration}
              onStartAnother={startFreshCall}
              onGoHome={() => navigate("/")}
            />
          );
        }
        // The subscription flow owns the screen when access is what ended the call.
        if (gate.blocksCall) {
          return (
            <>
              <SubscriptionAccessScreen
                gate={gate}
                host={host}
                onChooseChannel={chooseChannel}
                onOpenSupportChat={openSupportChat}
                onStartNewCall={startFreshCall}
                onGoHome={() => navigate("/")}
                welcomeBackName={session.caller.fullName}
              />
              {supportOverlay}
            </>
          );
        }
        return (
          <CallOutcomeScreen
            host={host}
            outcome={{ kind: "ended", endedByHost, durationSeconds: endedDuration }}
            onCallAgain={startFreshCall}
            onGoHome={() => navigate("/")}
          />
        );

      default:
        return <Navigate to="/" replace />;
    }
  }

  /* ------------------------------- the legacy simulated / demo path, intact */

  switch (session.status) {
    case "preparing":
      return (
        <ConnectingPage
          host={host}
          title="Preparing your call…"
          copy="Setting up your camera and microphone."
        />
      );

    case "requesting_permissions":
      return (
        <ConnectingPage
          host={host}
          title="Waiting for permission…"
          copy={
            session.type === "video"
              ? "Allow camera and microphone access to continue."
              : "Allow microphone access to continue."
          }
        />
      );

    case "connecting":
      return <LiveRingingScreen host={host} stage="connecting" onCancel={live.cancel} />;

    case "inviting":
      return <LiveRingingScreen host={host} stage="requesting" onCancel={live.cancel} />;

    case "ringing":
      return <LiveRingingScreen host={host} stage="ringing" onCancel={live.cancel} />;

    case "accepted":
      return <LiveRingingScreen host={host} stage="accepted" onCancel={live.cancel} />;

    case "active":
      // Audio calls have their own screen: no camera is requested for them, so
      // there is nothing to show but the person being called.
      {
        // The only thing the checkpoint ever puts over a running call: a status
        // message that changes nothing about the call underneath it.
        const overlay =
          session.status === "active" ? (
            <>
              <SubscriptionCheckpoint gate={gate} />
              {/* A notice, not an interruption: the call carries on around it. */}
              {limit.warning && session.access && (
                <p className="session-limit-notice" role="status">
                  <Icon name="clock" className="size-4" />
                  {t("sessionLimit.remaining", { plan: session.access.planName })}
                </p>
              )}
            </>
          ) : null;

        return session.type === "audio" ? (
          <ActiveAudioCallPage
            host={host}
            media={media}
            remote={remote}
            callStatus={session.status}
            startedAt={session.startedAt}
            onEnd={endCall}
            accessOverlay={overlay}
            subscriptionChecking={gate.status === "checking"}
            onRemoteEnded={onRemoteEnded}
          />
        ) : (
          <ActiveVideoCallPage
            host={host}
            media={media}
            remote={remote}
            callType={session.type}
            callStatus={session.status}
            startedAt={session.startedAt}
            onEnd={endCall}
            timedSourcePreview={hasUploadedFreeVideoPreview}
            accessOverlay={overlay}
            subscriptionChecking={gate.status === "checking"}
            onRemoteEnded={onRemoteEnded}
          />
        );
      }

    case "ended":
      // A paid session that simply ran out of time. Said plainly, because
      // "Call ended" would read as though something went wrong.
      if (limitReached && session.access) {
        return (
          <SessionCompletePage
            host={host}
            planName={session.access.planName}
            durationSeconds={endedDuration}
            onStartAnother={startFreshCall}
            onGoHome={() => navigate("/")}
          />
        );
      }

      // A call ended for want of a subscription hands the screen to the access
      // flow. The call itself is finished either way: this is what happens next,
      // not a continuation of it.
      if (gate.blocksCall) {
        return (
          <>
            <SubscriptionAccessScreen
              gate={gate}
              host={host}
              onChooseChannel={chooseChannel}
              onOpenSupportChat={openSupportChat}
              onStartNewCall={startFreshCall}
              onGoHome={() => navigate("/")}
              welcomeBackName={session.caller.fullName}
            />
            {supportOverlay}
          </>
        );
      }

      return (
        <CallEndedPage
          host={host}
          // Never connected means cancelled, and no duration is reported.
          outcome={session.startedAt === null ? "cancelled" : "ended"}
          durationSeconds={endedDuration}
          onStartNewCall={() => navigate("/connect")}
          onGoHome={() => navigate("/")}
        />
      );

    case "failed":
      return (
        <PermissionMessage
          error={media.error ?? FALLBACK_MEDIA_ERROR}
          permission={permission}
          busy={mediaStatus === "requesting"}
          onRetry={startFreshCall}
          onBack={() => navigate(`/join/${session.type}`)}
          onGoHome={() => navigate("/")}
        />
      );

    default:
      return <Navigate to="/" replace />;
  }
}

export default CallSessionRoute;
