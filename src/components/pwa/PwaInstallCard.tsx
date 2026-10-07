import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isIosDevice(): boolean {
  const platform = navigator.platform ?? "";
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isRunningInstalled(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

/** An unobtrusive home-screen entry with native install and iOS guidance. */
export function PwaInstallCard() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(false);

  useEffect(() => {
    setInstalled(isRunningInstalled());
    setIos(isIosDevice());
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
      setOpen(false);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const install = async () => {
    if (!promptEvent) {
      setOpen(true);
      return;
    }
    setInstalling(true);
    setInstallError(false);
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      setPromptEvent(null);
      if (choice.outcome === "accepted") {
        setInstalled(true);
        setOpen(false);
      }
    } catch {
      setInstallError(true);
    } finally {
      setInstalling(false);
    }
  };

  if (installed) return null;

  return (
    <div className="pwa-install-entry" onPointerUp={(event) => event.stopPropagation()}>
      <button type="button" className="pwa-install-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Icon name="download" className="size-4" />
        <span>Get the app</span>
      </button>

      {open && (
        <div className="pwa-install-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="pwa-install-card" role="dialog" aria-modal="true" aria-labelledby="pwa-install-title">
            <button type="button" className="pwa-install-close" aria-label="Close install card" onClick={() => setOpen(false)}>
              <Icon name="close" className="size-5" />
            </button>

            <div className="pwa-install-icon-wrap">
              <img src="/branding/callastar-mark.svg" alt="" className="pwa-install-icon" />
              <span className="pwa-install-icon-sparkle" aria-hidden="true">✦</span>
            </div>
            <p className="pwa-install-eyebrow">CALLASTAR, ONE TAP AWAY</p>
            <h2 id="pwa-install-title">Your people, closer.</h2>
            <p className="pwa-install-copy">Add CallaStar to your home screen for a full-screen calling experience and quicker access whenever you want to connect.</p>

            <ul className="pwa-install-benefits">
              <li><span><Icon name="check" className="size-4" /></span>Launch straight into CallaStar</li>
              <li><span><Icon name="check" className="size-4" /></span>A clean, app-like full-screen view</li>
              <li><span><Icon name="check" className="size-4" /></span>Your home-screen shortcut, ready when you are</li>
            </ul>

            {ios && (
              <div className="pwa-install-ios-steps">
                <span className="pwa-install-step-number">1</span>
                <p>Tap <strong>Share</strong> in your browser, choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</p>
              </div>
            )}

            {installError && <p className="pwa-install-error" role="alert">The install prompt did not open. Use your browser menu and choose “Install app” or “Add to Home Screen.”</p>}

            {promptEvent ? (
              <button type="button" className="pwa-install-action" onClick={() => void install()} disabled={installing}>
                <Icon name="download" className="size-5" />
                {installing ? "Opening install…" : "Install CallaStar"}
              </button>
            ) : !ios ? (
              <p className="pwa-install-browser-hint">Open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</p>
            ) : null}

            <p className="pwa-install-footnote">Free to install. Calls still need an internet connection.</p>
          </section>
        </div>
      )}
    </div>
  );
}

export default PwaInstallCard;
