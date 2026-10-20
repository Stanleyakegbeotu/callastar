import { CallaStarLogo } from "@/components/branding/CallaStarLogo"
import { Button } from "@/components/ui/Button"
import { Icon } from "@/components/ui/Icon"
import { useTranslation } from "react-i18next"

export default function SourceSessionEndedPage({
  free,
  onHome,
  onAnother,
  onSupport,
}: {
  free: boolean
  onHome: () => void
  onAnother: () => void
  onSupport: () => void
}) {
  const { t } = useTranslation()

  if (free) {
    return (
      <main className="trial-ended" aria-labelledby="trial-ended-title">
        <div className="trial-ended-content">
          <h1 id="trial-ended-title" className="trial-ended-title">
            {t("trialCompletion.title")}
          </h1>
          <p className="trial-ended-copy">{t("trialCompletion.copy")}</p>
          <Button className="trial-ended-home" onClick={onHome} withArrow={false}>
            {t("common.returnHome")}
          </Button>
        </div>
      </main>
    )
  }

  return (
    <div className="page-shell">
      <main className="host-state call-ticket-outcome">
        <div className="host-state-brand">
          <CallaStarLogo />
        </div>
        <span className="host-state-icon" aria-hidden="true">
          <Icon name="phone" className="size-8" />
        </span>
        <h1 className="cs-display">
          Call ended
        </h1>
        <p className="cs-lede">Your call session has ended.</p>
        <div className="host-state-actions">
          <Button onClick={onHome} withArrow={false}>
            Back Home
          </Button>
          <Button variant="secondary" onClick={onAnother} withArrow={false}>
            Enter Call ID
          </Button>
          <Button variant="secondary" onClick={onSupport} withArrow={false}>
            Customer Care
          </Button>
        </div>
      </main>
    </div>
  )
}
