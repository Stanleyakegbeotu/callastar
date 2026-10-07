import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { AppHeader } from "@/components/layout/AppHeader";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { config } from "@/lib/config";
import type { EntryOutcome } from "@/services/access/resolveEntry";
import { createSessionId } from "@/services/callSession";
import { useCallSession } from "@/state/CallSessionContext";
import { useClearStaleSession } from "@/state/useClearStaleSession";
import type { CallType } from "@/types/call";
import type { HostPreview } from "@/types/host";

import { JoinCallForm } from "./JoinCallForm";
import { ProfileInactiveScreen, ReturningSubscriptionScreen, WelcomeBackScreen } from "./HostStateScreens";
import type { JoinCallValues } from "./validation";

function parseCallType(value: string | undefined): CallType | null {
  return value === "video" || value === "audio" ? value : null;
}

/**
 * Step 2 container. The call type comes from the URL so `/join/video` is a real
 * address rather than a screen name held in memory.
 *
 * This is also where an entered ID stops being a form field and becomes an
 * outcome. Everything except a plain first call ends the flow on a screen of
 * its own — and every one of those decisions is made before a camera or
 * microphone is touched.
 */
export function JoinCallPage() {
  const params = useParams<{ callType: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  useClearStaleSession();
  const { dispatch } = useCallSession();
  const callType = parseCallType(params.callType);

  /** The screen an entered ID led to, when it was not a plain call. */
  const [outcome, setOutcome] = useState<{ values: JoinCallValues; result: EntryOutcome } | null>(null);

  // Keep session state in step with the URL, including on a deep link.
  useEffect(() => {
    if (callType && (callType !== "audio" || config.audioCallsEnabled)) {
      dispatch({ type: "SET_CALL_TYPE", callType });
    }
  }, [callType, dispatch]);

  if (!callType) {
    return <Navigate to="/connect" replace />;
  }

  if (callType === "audio" && !config.audioCallsEnabled) {
    return <Navigate to="/join/video" replace />;
  }

  /** Put the caller and host into session state, ready for a call. */
  const prepareSession = (values: JoinCallValues, host: HostPreview) => {
    dispatch({
      type: "SET_CALLER_DETAILS",
      caller: { fullName: values.fullName, phone: values.phone, email: values.email },
    });
    dispatch({ type: "SET_CALL_ID", callId: values.callId });
    dispatch({ type: "SET_HOST", host });
  };

  const handleSubmit = (values: JoinCallValues, host: HostPreview) => {
    prepareSession(values, host);
    // An unpaid preview call: no authorisation attached, so the checkpoint runs.
    dispatch({ type: "SET_ACCESS", access: null });

    // The call screen asks for devices next; the session is only recorded once
    // they are granted, so an abandoned dialog leaves no history behind.
    const sessionId = createSessionId();
    dispatch({ type: "START_SESSION", id: sessionId });
    navigate(`/call/${sessionId}`);
  };

  /** Start the authorised call a valid Subscription Access ID paid for. */
  const startAuthorizedCall = () => {
    if (!outcome || outcome.result.kind !== "authorized") return;
    const { host, access, plan } = outcome.result;

    prepareSession(outcome.values, host);
    dispatch({
      type: "SET_ACCESS",
      access: {
        accessIdRecordId: access.id,
        planId: plan.id,
        planName: plan.displayName,
        // Read from the plan as it stands now, not as it was when sold.
        sessionDurationMinutes: plan.sessionDurationMinutes,
        validatedAt: Date.now(),
      },
    });

    const sessionId = createSessionId();
    dispatch({ type: "START_SESSION", id: sessionId });
    navigate(`/call/${sessionId}`);
  };

  const backToId = () => setOutcome(null);

  if (outcome) {
    const { result } = outcome;

    if (result.kind === "inactive") {
      return (
        <div className="page-shell join-page">
          <ProfileInactiveScreen
            host={result.host}
            onReturnHome={() => navigate("/")}
            onEnterAnotherId={backToId}
          />
        </div>
      );
    }

    if (result.kind === "returning") {
      return (
        <div className="page-shell join-page">
          <ReturningSubscriptionScreen
            host={result.host}
            callId={outcome.values.callId}
            callType={callType}
            // Plans live on the post-call access screen, which needs a host and
            // a caller in state to create a request against.
            onContinueToPlans={() => {
              prepareSession(outcome.values, result.host);
              navigate("/plans");
            }}
            onReturnHome={() => navigate("/")}
          />
        </div>
      );
    }

    if (result.kind === "authorized") {
      return (
        <div className="page-shell join-page">
          <WelcomeBackScreen
            host={result.host}
            access={result.access}
            plan={result.plan}
            onStartNewCall={startAuthorizedCall}
            onReturnHome={() => navigate("/")}
          />
        </div>
      );
    }

    if (result.kind === "access-invalid") {
      return (
        <div className="page-shell join-page">
          <main className="host-state">
            <div className="host-state-brand">
              <CallaStarLogo />
            </div>
            <span className="host-state-icon host-state-icon-warning" aria-hidden="true">
              <Icon name="info" className="size-8" />
            </span>
            <h1 className="cs-display">{t("entry.notRecognisedTitle")}</h1>
            {/* Deliberately the same message whether the ID is unknown or was
                revoked: which one it is, is not a stranger's to learn. */}
            <p className="cs-lede">
              {result.reason === "plan_unavailable"
                ? t("entry.planUnavailableCopy")
                : t("entry.notRecognisedCopy")}
            </p>
            <div className="host-state-actions">
              <Button onClick={backToId} withArrow={false}>
                {t("entry.tryAgain")}
              </Button>
              <Button variant="secondary" withArrow={false} onClick={() => navigate("/")}>
                {t("common.returnHome")}
              </Button>
            </div>
          </main>
        </div>
      );
    }
  }

  return (
    <div className="page-shell join-page">
      <div className="join-backdrop" aria-hidden="true">
        <div className="join-backdrop-orb join-backdrop-orb-one" />
        <div className="join-backdrop-orb join-backdrop-orb-two" />
      </div>
      <AppHeader minimal />
      <main className="form-wrap" aria-label={`Join ${callType} call`}>
        <JoinCallForm
          callType={callType}
          onCancel={() => navigate("/connect")}
          onSubmit={handleSubmit}
          onOutcome={(values, result) => setOutcome({ values, result })}
        />
      </main>
    </div>
  );
}

export default JoinCallPage;
