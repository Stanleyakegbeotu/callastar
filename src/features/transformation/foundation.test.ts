import { describe, expect, it } from "vitest";
import { detectTransformationCapabilities } from "./capabilities";
import { isTransformationSourceKind, type TransformationEngine, type TransformationOutput } from "./types";

describe("transformation foundation", () => {
  it("accepts only supported source kinds", () => {
    expect(isTransformationSourceKind("image")).toBe(true);
    expect(isTransformationSourceKind("video")).toBe(true);
    expect(isTransformationSourceKind("camera")).toBe(false);
  });

  it("detects missing browser APIs without querying devices", () => {
    const capabilities = detectTransformationCapabilities({} as typeof globalThis);
    expect(Object.values(capabilities).every((value) => value === false)).toBe(true);
  });

  it("keeps an output video track in the engine contract", () => {
    type Started = Awaited<ReturnType<TransformationEngine["start"]>>;
    const outputIsCompatible: Started extends TransformationOutput ? true : false = true;
    expect(outputIsCompatible).toBe(true);
  });
});
