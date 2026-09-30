import { useEffect, useRef } from "react";

import { logDiagnostic } from "@/lib/utils";

/**
 * The tone you hear while a call is going through.
 *
 * Synthesised rather than a bundled audio file: ringback is two steady tones
 * and a cadence, which Web Audio produces exactly and which costs nothing to
 * download. It is also the honest option — this is the caller's own local
 * feedback, not a sound arriving from the other end.
 *
 * The cadence is the standard pair at 440 Hz and 480 Hz, two seconds on and
 * four off. Gain is ramped rather than switched, because an abrupt gate on a
 * running oscillator is an audible click.
 */

/** Quiet enough to sit under a room, loud enough to be heard on a phone. */
const LEVEL = 0.09;
const RAMP_SECONDS = 0.04;
const ON_SECONDS = 2;
const OFF_SECONDS = 4;
const FREQUENCIES = [440, 480];

interface Ringback {
  context: AudioContext;
  gain: GainNode;
  oscillators: OscillatorNode[];
  timer: number | null;
}

export function useRingbackTone(enabled: boolean): void {
  const ringback = useRef<Ringback | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const AudioContextClass =
      window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    let cancelled = false;
    let active: Ringback | null = null;

    try {
      const context = new AudioContextClass();
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);

      const oscillators = FREQUENCIES.map((frequency) => {
        const oscillator = context.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start();
        return oscillator;
      });

      active = { context, gain, oscillators, timer: null };
      ringback.current = active;

      /**
       * Schedule one burst and the silence after it, then come back for more.
       * Scheduling on the audio clock keeps the cadence steady even when the
       * main thread is busy rendering the call.
       */
      const burst = () => {
        if (cancelled || !active) return;
        const now = active.context.currentTime;
        const parameter = active.gain.gain;

        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(parameter.value, now);
        parameter.linearRampToValueAtTime(LEVEL, now + RAMP_SECONDS);
        parameter.setValueAtTime(LEVEL, now + ON_SECONDS - RAMP_SECONDS);
        parameter.linearRampToValueAtTime(0, now + ON_SECONDS);

        active.timer = window.setTimeout(burst, (ON_SECONDS + OFF_SECONDS) * 1000);
      };

      // A browser may hold the context suspended until a gesture. Placing a
      // call is one, so this normally resumes immediately; if it does not, the
      // call is simply silent rather than broken.
      void context
        .resume()
        .then(() => {
          if (!cancelled) burst();
        })
        .catch((error: unknown) => logDiagnostic("ringback-resume", error));
    } catch (error) {
      logDiagnostic("ringback", error);
    }

    return () => {
      cancelled = true;
      const current = active;
      ringback.current = null;
      if (!current) return;

      if (current.timer !== null) window.clearTimeout(current.timer);
      try {
        // Ramp down before stopping, so ending a call is not a click.
        const now = current.context.currentTime;
        current.gain.gain.cancelScheduledValues(now);
        current.gain.gain.setValueAtTime(current.gain.gain.value, now);
        current.gain.gain.linearRampToValueAtTime(0, now + RAMP_SECONDS);
        current.oscillators.forEach((oscillator) => oscillator.stop(now + RAMP_SECONDS * 2));
      } catch (error) {
        logDiagnostic("ringback-stop", error);
      }
      // Release the audio hardware; nothing here is reused.
      window.setTimeout(() => void current.context.close().catch(() => undefined), 200);
    };
  }, [enabled]);
}
