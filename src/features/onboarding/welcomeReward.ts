const WELCOME_REWARD_KEY = "callastar-welcome-reward-seen";

export function hasSeenWelcomeReward(): boolean {
  try {
    return window.localStorage.getItem(WELCOME_REWARD_KEY) === "true";
  } catch {
    return false;
  }
}

export function markWelcomeRewardSeen(): void {
  try {
    window.localStorage.setItem(WELCOME_REWARD_KEY, "true");
  } catch {
    // Storage is optional; it must never block the call selection flow.
  }
}
