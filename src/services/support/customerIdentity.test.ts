import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCustomerEmail, readSupportCustomerIdentity, saveSupportCustomerIdentity } from "./customerIdentity";

beforeEach(() => {
  const storage = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), clear: () => values.clear() };
  };
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});

describe("accountless customer identity", () => {
  it("uses one normalized email for caller identity lookup", () => {
    expect(normalizeCustomerEmail("  Stanley@Example.com ")).toBe("stanley@example.com");
    expect(normalizeCustomerEmail("stanley@example.com")).toBe("stanley@example.com");
  });

  it("reuses caller details on the same browser and keeps a guest session key", () => {
    const saved = saveSupportCustomerIdentity({ fullName: "Stanley Akegbeotu", email: "Stanley@Example.com", phone: "+2348000000000" });
    const restored = readSupportCustomerIdentity();
    expect(restored.normalizedEmail).toBe("stanley@example.com");
    expect(restored.name).toBe("Stanley Akegbeotu");
    expect(restored.phone).toBe("+2348000000000");
    expect(restored.guestSessionId).toBe(saved.guestSessionId);
  });
});
