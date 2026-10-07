import { describe, expect, it } from "vitest";

import { DEFAULT_PLANS } from "./defaultPlans";

describe("CallaStar subscription packages", () => {
  it("ships exactly Plus and Pro, in admin-configured display order", () => {
    expect(DEFAULT_PLANS.map(({ id }) => id)).toEqual(["plus", "pro"]);
    expect(DEFAULT_PLANS.map(({ displayName }) => displayName)).toEqual(["Plus", "Pro"]);
    expect(DEFAULT_PLANS.map(({ sortOrder }) => sortOrder)).toEqual([1, 2]);
    expect(DEFAULT_PLANS.every(({ currencyCode }) => currencyCode === "USD")).toBe(true);
  });

  it("keeps Plus lower tier and Pro higher tier", () => {
    const [plus, pro] = DEFAULT_PLANS;
    expect(plus.sessionDurationMinutes).toBeLessThan(pro.sessionDurationMinutes);
    expect(plus.priceMinorUnits).toBeLessThan(pro.priceMinorUnits);
    expect(plus.isMostPopular).toBe(true);
    expect(pro.isMostPopular).toBe(false);
  });
});
