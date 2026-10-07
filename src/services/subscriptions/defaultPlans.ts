import type { SubscriptionPlan } from "./types";

/**
 * The two plans CallaStar ships with, seeded once when the local store is empty.
 *
 * Quality wording is deliberate: no plan promises 4K, because what a call can
 * actually deliver depends on the device, the network and the source media.
 * Every tier includes the same core calling benefits. Plans differ by session length.
 */
export const DEFAULT_PLANS: Omit<SubscriptionPlan, "createdAt" | "updatedAt">[] = [
  {
    id: "plus",
    displayName: "Plus",
    priceMinorUnits: 3900,
    currencyCode: "USD",
    sortOrder: 1,
    sessionDurationMinutes: 30,
    supportPriority: "priority",
    description: "More time to enjoy your CallaStar sessions.",
    features: [
      "Stable calls, subject to your network and device",
      "Uninterrupted sessions when connection conditions allow",
      "Secure conversations with built-in protections",
      "HD video and audio where your device and connection support it",
      "Free meet-and-greet pass included with every package",
      "One-time access with no recurring billing",
      "Up to 30 minutes per supported session",
    ],
    isActive: true,
    isMostPopular: true,
  },
  {
    id: "pro",
    displayName: "Pro",
    priceMinorUnits: 6900,
    currencyCode: "USD",
    sortOrder: 2,
    sessionDurationMinutes: 60,
    supportPriority: "highest",
    description: "The most time for an unhurried CallaStar session.",
    features: [
      "Stable calls, subject to your network and device",
      "Uninterrupted sessions when connection conditions allow",
      "Secure conversations with built-in protections",
      "HD video and audio where your device and connection support it",
      "Free meet-and-greet pass included with every package",
      "One-time access with no recurring billing",
      "Up to 60 minutes per supported session",
    ],
    isActive: true,
    isMostPopular: false,
  },
];
