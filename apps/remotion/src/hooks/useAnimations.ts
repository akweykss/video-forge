// ============================================================
// useAnimations — Custom hook wrapping common animation patterns
// ============================================================
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { springPresets } from '../utils/animations';

type SpringPreset = keyof typeof springPresets;

/**
 * Returns a spring-based fade-in opacity (0 → 1).
 */
export function useFadeIn(delay: number = 0, duration: number = 20) {
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return { opacity };
}

/**
 * Returns a spring-based slide-in transform value and opacity.
 */
export function useSlideIn(
  direction: 'left' | 'right' | 'up' | 'down' = 'left',
  delay: number = 0,
  preset: SpringPreset = 'smooth',
) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: springPresets[preset],
  });

  const distance = 150;

  const transforms: Record<string, string> = {
    left: `translateX(${interpolate(progress, [0, 1], [-distance, 0])}px)`,
    right: `translateX(${interpolate(progress, [0, 1], [distance, 0])}px)`,
    up: `translateY(${interpolate(progress, [0, 1], [-distance, 0])}px)`,
    down: `translateY(${interpolate(progress, [0, 1], [distance, 0])}px)`,
  };

  return {
    transform: transforms[direction],
    opacity: progress,
  };
}

/**
 * Returns a spring-based scale-in transform (0 → 1).
 */
export function useScaleIn(delay: number = 0, preset: SpringPreset = 'bouncy') {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: springPresets[preset],
  });

  return {
    transform: `scale(${progress})`,
    opacity: progress,
  };
}

/**
 * Returns a spring-based bounce transform (scale overshoot).
 */
export function useBounce(delay: number = 0) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: springPresets.bouncy,
  });

  return {
    transform: `scale(${progress})`,
    opacity: interpolate(progress, [0, 0.3], [0, 1], {
      extrapolateRight: 'clamp',
    }),
  };
}

/**
 * Returns pulsing scale value — useful for CTA buttons.
 */
export function usePulse(frequency: number = 0.06, amplitude: number = 0.06) {
  const frame = useCurrentFrame();

  const scale = 1 + Math.sin(frame * frequency * Math.PI * 2) * amplitude;

  return {
    transform: `scale(${scale})`,
  };
}

/**
 * Returns a typing cursor blink opacity.
 */
export function useBlinkCursor(blinkRate: number = 0.5) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cycleLength = Math.round(fps * blinkRate);
  const isVisible = Math.floor(frame / cycleLength) % 2 === 0;

  return { opacity: isVisible ? 1 : 0 };
}
