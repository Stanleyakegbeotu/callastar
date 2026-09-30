import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { looksLikeCallId } from "@/lib/callId";
import { classifyEntryId, resolveEntryId, type EntryOutcome } from "@/services/access/resolveEntry";
import { CALL_TIMINGS, config, isLiveCallingConfigured } from "@/lib/config";
import { DEMO_CALLER, EMPTY_CALLER } from "@/lib/constants";
import type { CallType } from "@/types/call";
import type { HostPreview } from "@/types/host";

import {
  hasErrors,
  normaliseJoinCall,
  validateField,
  type JoinCallErrors,
  type JoinCallField,
  type JoinCallValues,
} from "./validation";

interface JoinCallFormProps {
  callType: CallType;
  onCancel: () => void;
  /** The host is whoever the Call ID resolved to, never a stand-in. */
  onSubmit: (values: JoinCallValues, host: HostPreview) => void;
  /**
   * Everything the entered ID can mean other than "start a normal call":
   * an unavailable host, a caller whose preview is spent, or paid access.
   * Handled by the page, because each one is a screen rather than a step.
   */
  onOutcome: (values: JoinCallValues, outcome: EntryOutcome) => void;
}

type JoinStep =
  | "details"
  | "call-id"
  | "resolving"
  | "not-found"
  | "network-error"
  | "confirmation"
  | "permission";

const DETAIL_FIELDS: { field: JoinCallField; placeholder: string; icon: IconName; type: string; autoComplete: string }[] = [
  { field: "fullName", placeholder: "Full Name", icon: "user", type: "text", autoComplete: "name" },
  { field: "phone", placeholder: "Phone Number", icon: "phone", type: "tel", autoComplete: "tel" },
  { field: "email", placeholder: "Email Address", icon: "mail", type: "email", autoComplete: "email" },
];

function initialValues(): JoinCallValues {
  const caller = config.prefillDemoForm ? DEMO_CALLER : EMPTY_CALLER;
  return {
    fullName: caller.fullName,
    phone: caller.phone,
    email: caller.email,
    // Never prefilled: a Call ID belongs to a profile someone created.
    callId: "",
  };
}

/**
 * The three-step entry dialog, drawn as in the approved screens: details, the
 * Call ID, then the host you are about to reach. Camera access is the final,
 * deliberate action rather than a side effect of filling in a form.
 */
export function JoinCallForm({ callType, onCancel, onSubmit, onOutcome }: JoinCallFormProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<JoinCallValues>(initialValues);
  const [errors, setErrors] = useState<JoinCallErrors>({});
  const [touched, setTouched] = useState<Partial<Record<JoinCallField, boolean>>>({});
  const [step, setStep] = useState<JoinStep>("details");
  const [resolvedHost, setResolvedHost] = useState<HostPreview | null>(null);
  const lookupTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (lookupTimer.current !== null) window.clearTimeout(lookupTimer.current);
    };
  }, []);

  const handleChange = (field: JoinCallField) => (event: ChangeEvent<HTMLInputElement>) => {
    const next = { ...values, [field]: event.target.value };
    setValues(next);
    if (touched[field]) {
      setErrors((previous) => ({ ...previous, [field]: validateField(field, next) }));
    }
  };

  const handleBlur = (field: JoinCallField) => () => {
    setTouched((previous) => ({ ...previous, [field]: true }));
    setErrors((previous) => ({ ...previous, [field]: validateField(field, values) }));
  };

  const showDetails = () => {
    setErrors({});
    setStep("details");
  };

  const handleDetailsSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: JoinCallErrors = {};
    for (const { field } of DETAIL_FIELDS) {
      const message = validateField(field, values);
      if (message) nextErrors[field] = message;
    }
    setErrors(nextErrors);
    setTouched({ fullName: true, phone: true, email: true });
    if (!hasErrors(nextErrors)) setStep("call-id");
  };

  const handleCallIdSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalised = normaliseJoinCall(values);
    // The same field takes either credential, because the person typing was
    // simply given "an ID" — by a host, or by support after paying.
    const kind = classifyEntryId(normalised.callId);
    const error = !normalised.callId
      ? validateField("callId", normalised)
      : kind === "unknown" && !looksLikeCallId(normalised.callId)
        ? "That does not look like a Call ID or a Subscription ID."
        : undefined;
    setValues(normalised);
    setErrors(error ? { callId: error } : {});
    setTouched((previous) => ({ ...previous, callId: true }));
    if (error) return;

    setStep("resolving");
    lookupTimer.current = window.setTimeout(() => {
      lookupTimer.current = null;
      void resolveEntryId(normalised.callId)
        .then((outcome) => {
          // A plain first call is the only outcome this dialog can finish; the
          // rest are screens of their own, because each one ends the flow here
          // rather than leading to a camera prompt.
          if (outcome.kind === "call") {
            setResolvedHost(outcome.host);
            setStep("confirmation");
            return;
          }
          if (outcome.kind === "not-found") {
            setStep("not-found");
            return;
          }
          onOutcome(normalised, outcome);
        })
        .catch(() => setStep("network-error"));
    }, CALL_TIMINGS.callIdLookupMs);
  };

  const renderDetails = () => (
    <form className="join-dialog" onSubmit={handleDetailsSubmit} noValidate>
      <div className="join-dialog-head">
        <span className="join-progress">Step 1 of 3</span>
        <button type="button" className="join-close" onClick={onCancel} aria-label="Close">
          <Icon name="close" className="size-5" />
        </button>
      </div>
      <h1 className="join-title">Your details</h1>
      <p className="join-copy">Tell us who&apos;s joining the call.</p>

      <div className="join-fields">
        {DETAIL_FIELDS.map(({ field, placeholder, icon, type, autoComplete }) => (
          <div key={field}>
            <div className="cs-field">
              <span className="cs-field-icon">
                <Icon name={icon} className="size-6" />
              </span>
              <input
                className="cs-input"
                type={type}
                value={values[field]}
                onChange={handleChange(field)}
                onBlur={handleBlur(field)}
                placeholder={placeholder}
                aria-label={placeholder}
                aria-invalid={errors[field] ? true : undefined}
                autoComplete={autoComplete}
              />
            </div>
            {errors[field] && (
              <p className="field-error" role="alert">
                {errors[field]}
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="join-disclaimer">No account or sign-up required.</p>
      <div className="join-actions">
        <Button type="submit">Next</Button>
        <button type="button" className="join-text-action" onClick={onCancel}>
          Back
        </button>
      </div>
    </form>
  );

  const renderCallId = () => (
    <form className="join-dialog join-dialog-centered" onSubmit={handleCallIdSubmit} noValidate>
      <button type="button" className="icon-back join-back" onClick={showDetails} aria-label="Go back">
        <Icon name="chevron" className="size-6" />
      </button>
      <h1 className="join-title">Enter Call ID</h1>
      <p className="join-copy">
        Enter the unique Call ID shared with you by the person you want to connect with.
      </p>

      <div className="join-fields">
        <input
          className="cs-input join-code-input"
          value={values.callId}
          onChange={handleChange("callId")}
          onBlur={handleBlur("callId")}
          placeholder="CS-7K4P-Q9MX-2J8R"
          aria-label="Call ID"
          aria-invalid={errors.callId ? true : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        {errors.callId && (
          <p className="field-error" role="alert">
            {errors.callId}
          </p>
        )}
        {/* One field, one quiet line. A second form for subscribers would make
            everybody read two things to do one. */}
        <p className="join-hint">{t("entry.subscriptionHint")}</p>
      </div>

      <div className="cs-note">
        <span className="cs-note-icon">
          <Icon name="info" className="size-6" />
        </span>
        <span>
          Call IDs only work for profiles available on CallaStar. If we can&apos;t find a matching profile,
          you&apos;ll be asked to check the ID and try again.
        </span>
      </div>

      <div className="join-actions">
        <Button type="submit">Find Profile</Button>
      </div>
    </form>
  );

  const renderResolving = () => (
    <section className="join-dialog join-dialog-status" aria-live="polite">
      <Spinner label="Finding your call" />
      <h1 className="join-title">Finding your call…</h1>
      <p className="join-copy">Checking the Call ID you entered.</p>
    </section>
  );

  const renderNotFound = () => (
    <section className="join-dialog join-dialog-status" aria-live="polite">
      <div className="join-status-icon">
        <Icon name="info" className="size-6" />
      </div>
      <h1 className="join-title">We couldn&apos;t find this Call ID.</h1>
      <p className="join-copy">Check the ID provided by your host and try again.</p>
      <div className="join-actions">
        <Button onClick={() => setStep("call-id")}>Try Again</Button>
        <button type="button" className="join-text-action" onClick={showDetails}>
          Back
        </button>
      </div>
    </section>
  );

  const renderNetworkError = () => (
    <section className="join-dialog join-dialog-status" aria-live="polite">
      <div className="join-status-icon">
        <Icon name="info" className="size-6" />
      </div>
      <h1 className="join-title">We couldn&apos;t reach CallaStar.</h1>
      <p className="join-copy">Check your connection and try again.</p>
      <div className="join-actions">
        <Button onClick={() => setStep("call-id")}>Try Again</Button>
        <button type="button" className="join-text-action" onClick={showDetails}>
          Back
        </button>
      </div>
    </section>
  );

  const renderConfirmation = () => {
    const profile = resolvedHost;
    if (!profile) return null;

    return (
      <section className="join-dialog join-dialog-centered">
        <h1 className="join-title">Ready to call</h1>

        <div className="ready-avatar">
          <img src={profile.avatarUrl} alt="" />
          <span className="ready-verified" aria-label="Verified profile">
            <Icon name="check" className="size-4" />
          </span>
          <span className="ready-online" aria-hidden="true" />
        </div>

        <p className="ready-name">{profile.displayName}</p>
        {profile.shortBio && <p className="ready-role">{profile.shortBio}</p>}
        <span className="ready-status">
          <span aria-hidden="true" />
          Ready to connect
        </span>

        <hr className="ready-divider" />
        <p className="join-copy">You&apos;re about to connect with {profile.displayName}.</p>

        <div className="join-actions">
          {/*
            On the live path this goes straight to the call, which checks that
            somebody is actually there to answer and only then explains the
            permission prompt. Stopping to talk about the camera first would put
            that explanation before the availability check — and would mean
            explaining a camera for a call that may not be possible.

            Without a signalling service there is no presence to check, so the
            original explainer step below still applies.
          */}
          <Button
            onClick={() =>
              isLiveCallingConfigured && resolvedHost
                ? onSubmit(normaliseJoinCall(values), resolvedHost)
                : setStep("permission")
            }
          >
            Start Call
          </Button>
        </div>
        <p className="join-disclaimer ready-footnote">
          {callType === "video" ? "Camera and microphone" : "Microphone"} access will be requested next.
        </p>
      </section>
    );
  };

  const renderPermission = () => (
    <section className="join-dialog join-dialog-centered join-permission">
      <div className="join-status-icon">
        <Icon name={callType === "video" ? "video" : "mic"} className="size-6" />
      </div>
      <h1 className="join-title">Allow {callType === "video" ? "camera & microphone" : "microphone"}</h1>
      <p className="join-copy">
        CallaStar needs access to your {callType === "video" ? "camera and microphone" : "microphone"} so you can
        join this {callType} call.
      </p>
      {callType === "video" && (
        <ul className="permission-list">
          <li>Camera — lets you appear on the call</li>
          <li>Microphone — lets the other person hear you</li>
        </ul>
      )}
      <div className="join-actions">
        <Button onClick={() => resolvedHost && onSubmit(normaliseJoinCall(values), resolvedHost)}>
          Allow access
        </Button>
        <button type="button" className="join-text-action" onClick={() => setStep("confirmation")}>
          Not now
        </button>
      </div>
    </section>
  );

  return (
    <div className="join-dialog-shell">
      {step === "details" && renderDetails()}
      {step === "call-id" && renderCallId()}
      {step === "resolving" && renderResolving()}
      {step === "not-found" && renderNotFound()}
      {step === "network-error" && renderNetworkError()}
      {step === "confirmation" && renderConfirmation()}
      {step === "permission" && renderPermission()}
    </div>
  );
}

export default JoinCallForm;
