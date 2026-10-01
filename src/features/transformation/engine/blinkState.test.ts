import { describe, expect, it } from "vitest";

import { BLINK_THRESHOLDS, BlinkStateMachine } from "./blinkState";
import { NEUTRAL_EXPRESSION, type ExpressionMotion } from "./expressionMotion";

const eyes = (left: number, right: number): ExpressionMotion => ({ ...NEUTRAL_EXPRESSION, blinkLeft: left, blinkRight: right, status: "tracked", calculationMs: 0 });

/** Feeds a sequence of measured closures at a tracker cadence; returns the last output. */
function run(sequence: [number, number][], stepMs = 50) {
  const machine = new BlinkStateMachine();
  let out: ExpressionMotion | null = null;
  sequence.forEach(([l, r], i) => { out = machine.apply(eyes(l, r), i * stepMs); });
  return { machine, out: out! as ExpressionMotion };
}

describe("blink states", () => {
  it("shows a complete blink as a closed eye even when the tracker under-reads it", () => {
    // The rendered closed eye measured 0.66 through MediaPipe; a real one, similar.
    const { out } = run([[0, 0], [0.3, 0.3], [0.62, 0.6]], 120);
    expect(out.blinkLeft).toBe(1);
    expect(out.blinkRight).toBe(1);
    expect(out.blinkState).toMatchObject({ left: "closed", right: "closed" });
  });

  it("catches a fast blink whose deepest frame fell between tracker frames", () => {
    const { out } = run([[0, 0], [0.42, 0.4]], 33);
    expect(out.blinkState).toMatchObject({ left: "closed", right: "closed" });
  });

  it("left wink: left closes, right is untouched", () => {
    // Measured coupling: the winking eye 0.50, the open one 0.18.
    const { out } = run([[0, 0], [0.5, 0.18]], 250);
    expect(out.blinkLeft).toBe(1);
    expect(out.blinkRight).toBe(0);
  });

  it("right wink: right closes, left is untouched", () => {
    const { out } = run([[0, 0], [0.14, 0.385]], 250);
    expect(out.blinkRight).toBe(1);
    expect(out.blinkLeft).toBe(0);
  });

  it("does not turn a slow, symmetric squint into a blink", () => {
    const { out } = run([[0, 0], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.45, 0.45]], 300);
    expect(out.blinkState).toMatchObject({ left: "closing", right: "closing" });
    expect(out.blinkLeft).toBeGreaterThan(0.2);
    expect(out.blinkLeft).toBeLessThan(0.5);
  });

  it("a half blink stays part-way", () => {
    const { out } = run([[0, 0], [0.45, 0.45]], 400);
    expect(out.blinkLeft).toBeGreaterThan(0);
    expect(out.blinkLeft).toBeLessThan(1);
  });

  it("holds closed through one noisy frame, then opens", () => {
    const { machine } = run([[0, 0], [0.7, 0.7]], 100);
    expect(machine.apply(eyes(0.45, 0.45), 300)!.blinkLeft).toBe(1);
    expect(machine.apply(eyes(BLINK_THRESHOLDS.REOPEN_BELOW - 0.05, 0.1), 350)!.blinkState!.left).toBe("opening");
    expect(machine.apply(eyes(0.05, 0.05), 400)!.blinkLeft).toBe(0);
  });

  it("treats lost tracking as unavailable, not as a closed eye, and starts over open", () => {
    const { machine } = run([[0, 0], [0.7, 0.7]], 100);
    expect(machine.apply(null, 300)).toBeNull();
    expect(machine.apply(eyes(0.1, 0.1), 400)!.blinkState).toMatchObject({ left: "open", right: "open" });
  });
});
