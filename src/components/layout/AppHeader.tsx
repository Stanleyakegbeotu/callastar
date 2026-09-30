import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Icon } from "@/components/ui/Icon";

/** Lightweight navigation for the setup flow. */
export function AppHeader({ onBack, minimal = false }: { onBack?: () => void; minimal?: boolean }) {
  return (
    <header className={`app-header ${minimal ? "app-header-minimal" : ""}`.trim()}>
      <div className="header-inner">
        {onBack ? (
          <button type="button" className="back-button" onClick={onBack} aria-label="Go back">
            <Icon name="chevron" className="size-5" />
          </button>
        ) : (
          <span className="size-10" aria-hidden="true" />
        )}
        <CallaStarLogo />
        <span className="size-10" aria-hidden="true" />
      </div>
    </header>
  );
}

export default AppHeader;
