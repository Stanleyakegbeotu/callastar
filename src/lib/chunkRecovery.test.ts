import { describe, expect, it } from "vitest";
import { claimChunkReload } from "./chunkRecovery";
describe("chunk recovery", () => {
  it("reloads once per five-minute window and refuses when storage is unavailable", () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    expect(claimChunkReload(storage, 1_000_000)).toBe(true);
    expect(claimChunkReload(storage, 1_000_001)).toBe(false);
    expect(claimChunkReload(storage, 1_300_001)).toBe(true);
    expect(claimChunkReload({ getItem: () => { throw new Error("denied"); }, setItem: () => {} })).toBe(false);
  });
});
