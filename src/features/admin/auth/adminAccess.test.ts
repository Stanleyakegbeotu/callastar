import { describe, expect, it } from "vitest";

import { hasActiveAdminAccess } from "./adminAccess";

describe("active admin access", () => {
  it("allows only an active admin profile", () => {
    expect(hasActiveAdminAccess({ role: "admin", is_active: true })).toBe(true);
  });

  it("rejects missing, inactive, or unauthorized profiles", () => {
    expect(hasActiveAdminAccess(null)).toBe(false);
    expect(hasActiveAdminAccess(undefined)).toBe(false);
    expect(hasActiveAdminAccess({ role: "admin", is_active: false })).toBe(false);
    expect(hasActiveAdminAccess({ role: "viewer", is_active: true })).toBe(false);
  });
});
