import { describe, expect, it } from "vitest";

import { currencyFractionDigits, formatMinorUnits, isCurrencyCode, majorAmountToMinorUnits } from "./money";

describe("subscription price currency handling", () => {
  it("formats minor units using each currency's fractional digits", () => {
    expect(formatMinorUnits(3900, "USD")).toBe("$39.00");
    expect(formatMinorUnits(3900, "JPY")).toBe("¥3,900");
    expect(currencyFractionDigits("USD")).toBe(2);
    expect(currencyFractionDigits("JPY")).toBe(0);
  });

  it("converts admin-entered currency units without floats in stored values", () => {
    expect(majorAmountToMinorUnits(39.95, "USD")).toBe(3995);
    expect(majorAmountToMinorUnits(3900, "JPY")).toBe(3900);
  });

  it("validates the three-letter currency field", () => {
    expect(isCurrencyCode("USD")).toBe(true);
    expect(isCurrencyCode("usd")).toBe(false);
    expect(isCurrencyCode("US" )).toBe(false);
  });
});
