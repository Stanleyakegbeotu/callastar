import { CallaStarLogo } from "@/components/branding/CallaStarLogo"
import { Button } from "@/components/ui/Button"

export default function CallTicketUnavailable({
  code,
  mode,
  onAnother,
  onSupport,
  onHome,
}: {
  code: string
  mode?: "free" | "premium"
  onAnother: () => void
  onSupport: () => void
  onHome: () => void
}) {
  const expired = code === "CALL_ID_EXHAUSTED" || code === "CALL_ID_RETIRED"
  return (
    <div className="page-shell join-page">
      <main className="host-state call-ticket-outcome">
        <div className="host-state-brand">
          <CallaStarLogo />
        </div>
        <h1 className="cs-display">
          {expired
            ? "This Call ID is no longer available."
            : code === "PROFILE_UNAVAILABLE"
              ? "Currently unavailable"
              : code === "SOURCE_MEDIA_UNAVAILABLE"
                ? "Host video unavailable"
                : code === "CALL_ID_NOT_FOUND"
                  ? "We couldn't find this Call ID"
                  : ["CALL_ID_RESERVATION_CONFLICT", "CALL_ID_TEMPORARILY_RESERVED"].includes(code)
                    ? "This Call ID is currently in use"
                    : "This Call ID is unavailable"}
        </h1>
        <p className="cs-lede">
          {expired
            ? mode === "free" && code === "CALL_ID_EXHAUSTED"
              ? "This free Call ID has reached its allowed call limit."
              : "This Call ID can no longer start a call."
            : code === "SOURCE_MEDIA_UNAVAILABLE"
              ? "Please ask the host to select a usable source video."
              : code === "PROFILE_UNAVAILABLE" ? "This host is not available to receive calls right now." : "Please try again shortly."}
        </p>
        {expired && (
          <p className="cs-lede">
            Ask the host for a new Call ID to make another call.
          </p>
        )}
        <div className="host-state-actions">
          <Button onClick={onAnother} withArrow={false}>
            Enter Another Call ID
          </Button>
          <Button variant="secondary" onClick={onSupport} withArrow={false}>
            Customer Care
          </Button>
          <button type="button" className="join-text-action" onClick={onHome}>
            Back Home
          </button>
        </div>
      </main>
    </div>
  )
}
