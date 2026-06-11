// ============================================================
// Animation Utilities — Spring presets & interpolation helpers
// ============================================================
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * Pre-configured spring presets for consistent motion design
 */
export const springPresets = {
  /** Playful bounce — great for titles and CTAs */
  bouncy: { damping: 8, mass: 0.6, stiffness: 120 },
  /** Smooth deceleration — for general content */
  smooth: { damping: 20, mass: 1, stiffness: 100 },
  /** Quick and tight — for UI elements and icons */
  snappy: { damping: 15, mass: 0.5, stiffness: 200 },
  /** Slow elegant — for backgrounds and subtle motion */
  slow: { damping: 30, mass: 1.5, stiffness: 60 },
} as const;

/**
 * Creates a fade-in value (0 → 1) starting at `delay` for `duration` frames.
 */
export function fadeIn(
  frame: number,
  delay: number = 0,
  duration: number = 20,
): number {
  return interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

/**
 * Creates a fade-out value (1 → 0) ending at `endFrame` over `duration` frames.
 */
export function fadeOut(
  frame: number,
  endFrame: number,
  duration: number = 20,
): number {
  return interpolate(frame, [endFrame - duration, endFrame], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

/**
 * Creates a slide-in translation value (offset → 0) starting at `delay`.
 */
export function slideIn(
  frame: number,
  delay: number = 0,
  direction: 'left' | 'right' | 'up' | 'down' = 'left',
  distance: number = 200,
): number {
  const offsets: Record<string, number> = {
    left: -distance,
    right: distance,
    up: -distance,
    down: distance,
  };

  return interpolate(frame, [delay, delay + 25], [offsets[direction], 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

/**
 * Creates a scale-in value (0 → 1) starting at `delay`.
 */
export function scaleIn(
  frame: number,
  delay: number = 0,
  duration: number = 20,
): number {
  return interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

/**
 * Creates a spring-based bounce value (0 → 1) for the current frame.
 * Must be called inside a React component (uses hooks).
 */
export function useSpring(
  preset: keyof typeof springPresets = 'smooth',
  delay: number = 0,
): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: springPresets[preset],
  });
}

/**
 * Interpolates a counting animation from 0 to targetValue.
 */
export function countUp(
  frame: number,
  targetValue: number,
  startFrame: number = 0,
  duration: number = 45,
): number {
  const raw = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [0, targetValue],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    },
  );
  return Math.round(raw);
}

/**
 * Creates a pulsing scale value oscillating between 1 and maxScale.
 */
export function pulse(
  frame: number,
  frequency: number = 0.05,
  maxScale: number = 1.08,
): number {
  const base = Math.sin(frame * frequency * Math.PI * 2);
  return interpolate(base, [-1, 1], [1, maxScale]);
}
