import { expect, it } from "vitest";
import { supabaseAccessRepository } from "./supabaseAccessRepository";
it("rejects asynchronously so profile effects can handle an unavailable access service", async () => {
  let pending: Promise<unknown> | undefined;
  expect(() => { pending = supabaseAccessRepository.listProfileAccessIds("host"); }).not.toThrow();
  await expect(pending).rejects.toThrow("unavailable");
});
