import { describe, expect, it } from "vitest";

import { formatCallId, generateCallId, isCallIdShape, looksLikeCallId, normalizeCallId } from "./callId";

describe("Call ID format and generation", () => {
  it("generates a cryptographically shaped, grouped Call ID", () => {
    const callId = generateCallId();

    expect(callId).toMatch(/^CS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){2}$/);
    expect(isCallIdShape(callId)).toBe(true);
  });

  it("normalizes case, spaces, and separators for lookup", () => {
    expect(normalizeCallId(" cs-7k4p q9mx-2j8r ")).toBe("CS7K4PQ9MX2J8R");
  });

  it("formats a normalized key into display groups", () => {
    expect(formatCallId("cs7k4pq9mx2j8r")).toBe("CS-7K4P-Q9MX-2J8R");
  });

  it("rejects invalid alphabet characters and lengths", () => {
    expect(isCallIdShape("CS-7K4I-Q9MX-2J8R")).toBe(false);
    expect(isCallIdShape("CS-7K4P-Q9MX-2J8")).toBe(false);
    expect(isCallIdShape("XX-7K4P-Q9MX-2J8R")).toBe(false);
  });

  it("keeps the join form check deliberately more lenient", () => {
    expect(looksLikeCallId("CS-DEMO-01")).toBe(true);
    expect(looksLikeCallId("x".repeat(25))).toBe(false);
  });
});
