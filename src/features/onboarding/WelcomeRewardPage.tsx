import { useNavigate } from "react-router-dom";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";

import { markWelcomeRewardSeen } from "./welcomeReward";

export function WelcomeRewardPage() {
  const navigate = useNavigate();

  const continueToCallSelection = () => {
    markWelcomeRewardSeen();
    navigate("/connect");
  };

  return (
    <main className="welcome-reward-page">
      <div className="welcome-reward-glow welcome-reward-glow-one" aria-hidden="true" />
      <div className="welcome-reward-glow welcome-reward-glow-two" aria-hidden="true" />
      <div className="welcome-reward-content">
        <div className="welcome-reward-brand">
          <CallaStarLogo size={42} />
        </div>

        <section className="welcome-reward-card" aria-labelledby="welcome-reward-title">
          <div className="welcome-gift-stage" aria-hidden="true">
            <span className="welcome-gift-halo" />
            <svg className="welcome-gift-star" viewBox="0 0 72 72" fill="none">
              <path d="m36 4 8.1 19.8L65 15.5 54.7 35.4 70 47 47.8 49.2 43 68l-10.2-17.5L13.5 58l9.9-19.2L4 26l22.1 2.3L36 4Z" fill="currentColor" />
              <path d="m36 4 8.1 19.8L65 15.5 54.7 35.4 70 47 47.8 49.2 43 68l-10.2-17.5L13.5 58l9.9-19.2L4 26l22.1 2.3L36 4Z" stroke="white" strokeWidth="2" strokeLinejoin="round" />
            </svg>
            <span className="welcome-gift-spark welcome-gift-spark-one">✦</span>
            <span className="welcome-gift-spark welcome-gift-spark-two">✧</span>
            <span className="welcome-gift-spark welcome-gift-spark-three">✦</span>
            <div className="welcome-gift-box">
              <div className="welcome-gift-lid">
                <span className="welcome-gift-lid-ribbon" />
                <span className="welcome-gift-bow welcome-gift-bow-left" />
                <span className="welcome-gift-bow welcome-gift-bow-right" />
              </div>
              <div className="welcome-gift-base">
                <span className="welcome-gift-base-ribbon" />
              </div>
            </div>
          </div>

          <p className="welcome-reward-eyebrow">A little something to get you started</p>
          <span className="welcome-reward-tag">FIRST-CALL REWARD</span>
          <h1 id="welcome-reward-title">Your first call is on us</h1>
          <p className="welcome-reward-copy">
            You&apos;ve been rewarded <strong>1 free call</strong> with any host of your choice.
          </p>
          <p className="welcome-reward-hint">Choose how you&apos;d like to connect, then pick a host.</p>

          <Button className="welcome-reward-action" onClick={continueToCallSelection}>
            Choose how to call
          </Button>
        </section>
      </div>
    </main>
  );
}

export default WelcomeRewardPage;
