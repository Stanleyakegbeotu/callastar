import type { SubscriptionPlan } from "./types";

/**
 * The three plans CallaStar ships with, seeded once when the store is empty.
 *
 * Quality wording is deliberate: no plan promises 4K, because what a call can
 * actually deliver depends on the device, the network and the source media.
 * Plans differ by session length, support priority and access priority.
 */
export const DEFAULT_PLANS: Omit<SubscriptionPlan, "createdAt" | "updatedAt">[] = [
  {
    id: "regular",
    displayName: "Regular",
    priceUsdCents: 1900,
    sessionDurationMinutes: 15,
    supportPriority: "standard",
    description: "Entry access for casual calls.",
    features: [
      "Continue eligible CallaStar sessions",
      "Up to 15 minutes per supported session",
      "Standard support queue",
      "Video and audio calling access",
      "HD-quality support when available",
    ],
    isActive: true,
    isMostPopular: false,
  },
  {
    id: "premium",
    displayName: "Premium",
    priceUsdCents: 3900,
    sessionDurationMinutes: 30,
    supportPriority: "priority",
    description: "Best value for more time and priority customer support.",
    features: [
      "Everything in Regular",
      "Up to 30 minutes per supported session",
      "Priority customer support",
      "Faster support/payment confirmation",
      "Video and audio calling access",
      "HD / high-resolution support where available",
    ],
    isActive: true,
    isMostPopular: true,
  },
  {
    id: "gold",
    displayName: "Gold Access",
    priceUsdCents: 6900,
    sessionDurationMinutes: 60,
    supportPriority: "highest",
    description: "Premium experience with the highest priority.",
    features: [
      "Everything in Premium",
      "Up to 60 minutes per supported session",
      "Highest support priority",
      "Priority access to eligible creator sessions",
      "Premium customer-care handling",
      "Video and audio calling access",
      "Highest available supported resolution where device/network permits",
    ],
    isActive: true,
    isMostPopular: false,
  },
];
