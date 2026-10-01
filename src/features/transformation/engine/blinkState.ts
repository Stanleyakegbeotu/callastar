import type { ExpressionMotion } from "./expressionMotion";

export type EyeState = "open" | "closing" | "closed" | "opening";

/**
 * Per-eye blink states, so a blink is shown as a blink.
 *
 * A real blink is over in about 150 ms. Tracking at 20–30 fps sees three or four
 * frames of it, rarely the deepest one, and MediaPipe's lid landmarks never
 * fully meet — so the measured closure of a complete blink often peaks around
 * 0.5–0.7. Passed straight through, that rendered as a half blink a viewer had
 * to guess at, which is the phone complaint. A decisive closure, by depth or by
 * speed, is therefore shown as a CLOSED eye; anything short of that (a squint,
 * a narrowing, a slow half-close) still follows the measurement.
 *
 *   open     → closing  measured closure rises past OPEN_BELOW
 *   closing  → closed   closure ≥ CLOSE_AT; or ≥ FAST_CLOSE_AT while closing
 *                       faster than FAST_RATE per second; or a WINK — at least
 *                       WINK_AT while the other eye is open and WINK_MARGIN
 *                       less closed. MediaPipe couples the eyes: a rendered,
 *                       geometrically shut eye beside an open one reads only
 *                       0.39–0.50, against 0.66 when both shut (measured,
 *                       transformation-m83-blink). Squints are symmetric, so
 *                       the asymmetry is what identifies a wink.
 *   closed   → opening  closure falls below REOPEN_BELOW (hysteresis: well
 *                       below CLOSE_AT, so one noisy frame cannot flicker it)
 *   opening  → open     closure below OPEN_BELOW; re-closing re-enters closed
 *
 * Short of closed, the output is rescaled so closures under OPEN_BELOW show as
 * nothing: coupling makes an open eye beside a wink read 0.14–0.18, and passed
 * through that narrowed the eye a wink must leave alone. The rescale is
 * continuous, so an eye narrowing for real still eases in.
 *
 * Each eye has its own machine — a wink is one eye — and missing data is not a
 * closed eye: with no expression the machine resets to open.
 */
export const BLINK_THRESHOLDS = {
  OPEN_BELOW: 0.2,
  CLOSE_AT: 0.55,
  FAST_CLOSE_AT: 0.35,
  FAST_RATE: 3,
  REOPEN_BELOW: 0.4,
  WINK_AT: 0.35,
  WINK_MARGIN: 0.2,
} as const;

class EyeMachine {
  state: EyeState = "open";
  private last: number | null = null;
  private lastAt = 0;

  update(closure: number, other: number, nowMs: number): number {
    const t = BLINK_THRESHOLDS;
    const dt = this.last === null ? 0 : (nowMs - this.lastAt) / 1000;
    const rate = this.last !== null && dt > 0 ? (closure - this.last) / dt : 0;
    this.last = closure;
    this.lastAt = nowMs;

    switch (this.state) {
      case "open":
      case "closing":
      case "opening":
        if (
          closure >= t.CLOSE_AT
          || (closure >= t.FAST_CLOSE_AT && rate >= t.FAST_RATE)
          || (closure >= t.WINK_AT && other < t.OPEN_BELOW && closure - other >= t.WINK_MARGIN)
        ) this.state = "closed";
        else if (closure < t.OPEN_BELOW) this.state = "open";
        else if (this.state === "open") this.state = "closing";
        break;
      case "closed":
        if (closure < t.REOPEN_BELOW) this.state = closure < t.OPEN_BELOW ? "open" : "opening";
        break;
    }
    if (this.state === "closed") return 1;
    return Math.max(0, closure - t.OPEN_BELOW) / (1 - t.OPEN_BELOW);
  }

  reset(): void {
    this.state = "open";
    this.last = null;
  }
}

export class BlinkStateMachine {
  private readonly left = new EyeMachine();
  private readonly right = new EyeMachine();

  /** Returns the expression with each eye's blink shaped by its state. */
  apply(expression: ExpressionMotion | null, nowMs: number): ExpressionMotion | null {
    if (!expression) {
      this.reset();
      return null;
    }
    const blinkLeft = this.left.update(expression.blinkLeft, expression.blinkRight, nowMs);
    const blinkRight = this.right.update(expression.blinkRight, expression.blinkLeft, nowMs);
    return {
      ...expression,
      blinkLeft,
      blinkRight,
      blinkState: { left: this.left.state, right: this.right.state, measuredLeft: expression.blinkLeft, measuredRight: expression.blinkRight },
    };
  }

  reset(): void {
    this.left.reset();
    this.right.reset();
  }
}
