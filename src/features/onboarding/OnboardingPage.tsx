import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { images } from "@/assets/images";
import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { MOCK_HOST } from "@/lib/constants";
import { useClearStaleSession } from "@/state/useClearStaleSession";

import { useDevAdminShortcut } from "./useDevAdminShortcut";

/** The three promises the landing screen makes, as drawn in the prototype. */
const HIGHLIGHTS: { icon: IconName; lines: [string, string] }[] = [
  { icon: "bolt", lines: ["No sign‑up", "required"] },
  { icon: "video", lines: ["Video &", "audio calls"] },
  { icon: "shield", lines: ["Secure", "connections"] },
];

/** Landing screen: full-bleed hero, the promise, and one way in. */
export function OnboardingPage() {
  const navigate = useNavigate();
  useClearStaleSession();
  // Hidden development shortcut. Contributes no markup and no styling of its
  // own: the brand area simply also receives pointer-up.
  const devAdmin = useDevAdminShortcut();
  const [returning] = useState(() => {
    try {
      return window.sessionStorage.getItem("callastar-onboarding-seen") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem("callastar-onboarding-seen", "true");
    } catch {
      // Storage is optional for the animation; never let it affect the flow.
    }
  }, []);

  return (
    <main className={`landing landing-wake ${returning ? "landing-returning" : ""}`.trim()}>
      <img className="landing-image" src={images.hero} alt="Woman smiling during a video call" />
      <div className="landing-overlay" />

      {/* The brand mark is unchanged: same element, same position, same
          spacing, no cursor and nothing to read. All it gains is a pointer
          handler, which is inert unless the development flag is on. */}
      <div className="landing-top landing-brand-reveal" {...devAdmin.handlers}>
        <CallaStarLogo />
      </div>

      {devAdmin.activating && (
        <p className="dev-shortcut-toast" role="status">
          Opening Admin…
        </p>
      )}

      {/* The person at the other end of the call, as supplied with the
          approved reference pack and served from /public. */}
      <div className="hero-pip landing-pip-reveal">
        <img src={images.onboardingParticipant} alt="" />
      </div>

      <div className="landing-content">
        {/* Each line is its own block for the reveal; the spaces keep the
            heading readable as text, not just as three stacked words. */}
        <h1 className="hero-title">
          {/* Three separate lines so the headline reveals one at a time, as in
              the motion reference. The trailing spaces keep it readable as a
              sentence when the markup is read as text. */}
          <span className="hero-title-line hero-title-line-1">Closer </span>
          <span className="hero-title-line hero-title-line-2">conversations, </span>
          <span className="hero-title-line hero-title-line-3">wherever you are.</span>
        </h1>
        <p className="hero-copy landing-copy-reveal">
          Real-time video and audio calls with your favourite creators, friends and family.
        </p>

        <ul className="hero-highlights">
          {HIGHLIGHTS.map((item, index) => (
            // Staggered one after another, so the row arrives as a group
            // rather than three things appearing at once.
            <li
              key={item.icon}
              className="landing-promise-reveal"
              style={{ animationDelay: `${1180 + index * 90}ms` }}
            >
              <Icon name={item.icon} className="size-6" />
              <span>
                {item.lines[0]}
                <br />
                {item.lines[1]}
              </span>
            </li>
          ))}
        </ul>

        <Button onClick={() => navigate("/connect")} className="landing-cta landing-cta-reveal">
          Get Started
        </Button>
      </div>
    </main>
  );
}

export default OnboardingPage;
