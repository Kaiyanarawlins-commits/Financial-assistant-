import { useEffect, useRef, useState } from 'react';

/**
 * Motion primitives.
 *
 * Every hook here checks `prefers-reduced-motion` and snaps straight to the
 * final value when it is set. That is not a nicety on a finance app: animated
 * counting numbers are a known migraine and vestibular trigger, and the figure
 * itself is the content — it has to be correct and readable instantly for
 * anyone who has asked their device for less movement.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Ease-out cubic: fast start, gentle settle. Reads as "landing" rather than "sliding". */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Animates a number toward its target.
 *
 * Used for the headline balance, so a change reads as movement rather than a
 * silent swap. The first render does not animate — a page load should show the
 * real figure immediately, not count up from zero every time the app opens.
 */
export function useAnimatedNumber(value: number, durationMs = 550): number {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number>();
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    if (prefersReducedMotion() || fromRef.current === value) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }

    const from = fromRef.current;
    const delta = value - from;
    const start = performance.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      setDisplay(Math.round(from + delta * easeOut(progress)));
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
      else fromRef.current = value;
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      fromRef.current = value;
    };
  }, [value, durationMs]);

  return display;
}

/**
 * Animates a percentage from 0 on mount, then to each new value.
 *
 * Progress bars fill from empty the first time they appear, which is what makes
 * a goal feel like progress rather than a static readout.
 */
export function useAnimatedPercent(target: number, durationMs = 900): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const fromRef = useRef(prefersReducedMotion() ? target : 0);
  const frameRef = useRef<number>();

  useEffect(() => {
    if (prefersReducedMotion()) {
      fromRef.current = target;
      setValue(target);
      return;
    }

    const from = fromRef.current;
    const delta = target - from;
    if (delta === 0) return;
    const start = performance.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      setValue(from + delta * easeOut(progress));
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
      else fromRef.current = target;
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      fromRef.current = target;
    };
  }, [target, durationMs]);

  return value;
}

/**
 * The colour a goal bar takes at a given completion: amber when it is barely
 * started, yellow-green through the middle, green at the finish — so progress
 * is readable from hue before you read the number.
 *
 * Interpolated in HSL, not RGB. Blending amber to green through RGB drags the
 * midpoint toward grey (a 32%-funded goal came out `rgb(145,147,167)`, a muddy
 * slate that reads as "disabled" rather than "a third of the way"). Rotating
 * hue keeps every intermediate colour saturated.
 */
export function goalColor(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const stops = [
    { at: 0, h: 40, s: 90, l: 55 },
    { at: 50, h: 78, s: 68, l: 47 },
    { at: 100, h: 152, s: 64, l: 46 },
  ];

  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i]!;
    const hi = stops[i + 1]!;
    if (clamped > hi.at) continue;
    const span = hi.at - lo.at;
    const t = span === 0 ? 0 : (clamped - lo.at) / span;
    const mix = (a: number, b: number) => a + (b - a) * t;
    return `hsl(${mix(lo.h, hi.h).toFixed(1)}, ${mix(lo.s, hi.s).toFixed(1)}%, ${mix(lo.l, hi.l).toFixed(1)}%)`;
  }
  const last = stops.at(-1)!;
  return `hsl(${last.h}, ${last.s}%, ${last.l}%)`;
}

/**
 * Draws an SVG path on by animating its dash offset. Returns props to spread
 * onto the element; falls back to a plain undashed stroke under reduced motion.
 */
export function useDrawIn(length: number, durationMs = 700, delayMs = 0) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setReady(true);
      return;
    }
    const timer = window.setTimeout(() => setReady(true), 20 + delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);

  if (prefersReducedMotion()) return {};
  return {
    style: {
      strokeDasharray: length,
      strokeDashoffset: ready ? 0 : length,
      transition: `stroke-dashoffset ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) ${delayMs}ms`,
    } as const,
  };
}
