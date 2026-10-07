/**
 * Imagery approved with the Figma design. Both are fictional people from
 * Unsplash — the hero on the landing screen and the stand-in host used
 * everywhere the remote participant appears.
 */
export const images = {
  hero: "/media/onboarding/girl-wallpaper.jpg",
  host:
    "https://images.unsplash.com/photo-1758598305779-8b8465d47e37?crop=entropy&cs=tinysrgb&fit=crop&fm=jpg&q=88&w=1000",
  /**
   * The person on the other end of the call shown on the landing screen.
   * Supplied with the approved reference pack and served from /public, so the
   * hero does not depend on a third-party image host.
   */
  onboardingParticipant: "/media/onboarding/male-participant.jpg",
  onboardingParticipantLandscape: "/media/onboarding/male-participant-landscape.png",
} as const;
