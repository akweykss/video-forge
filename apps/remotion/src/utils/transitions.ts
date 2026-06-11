// ============================================================
// Transition utilities — TikTok-style scene transitions
// Returns CSS style objects for incoming scene animations
// ============================================================
import { interpolate, Easing } from 'remotion';
import type React from 'react';

export type TransitionType = 'cut' | 'fade' | 'zoom-in' | 'zoom-out' | 'slide-left' | 'whip';

/**
 * Returns opacity, transform, filter styles for a scene entering with the given transition.
 * Apply the returned style to the wrapper div of the incoming scene.
 */
export function getTransitionStyle(
  frame: number,
  transitionFrames: number,
  transitionType: TransitionType
): React.CSSProperties {
  const easeOut = Easing.out(Easing.cubic);

  switch (transitionType) {
    case 'cut': {
      // Instant cut — 0→1 in 1 frame
      const opacity = frame < 1 ? 0 : 1;
      return { opacity };
    }

    case 'fade': {
      // Smooth opacity fade over transitionFrames
      const opacity = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: easeOut,
      });
      return { opacity };
    }

    case 'zoom-in': {
      // Scale from 1.3 → 1, opacity 0 → 1
      const progress = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: easeOut,
      });
      const scale = interpolate(progress, [0, 1], [1.3, 1]);
      const opacity = progress;
      return {
        opacity,
        transform: `scale(${scale})`,
      };
    }

    case 'zoom-out': {
      // Scale from 0.7 → 1, opacity 0 → 1
      const progress = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: easeOut,
      });
      const scale = interpolate(progress, [0, 1], [0.7, 1]);
      const opacity = progress;
      return {
        opacity,
        transform: `scale(${scale})`,
      };
    }

    case 'slide-left': {
      // Slide from right: translateX(100%) → translateX(0)
      const translateX = interpolate(frame, [0, transitionFrames], [100, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: easeOut,
      });
      return {
        transform: `translateX(${translateX}%)`,
      };
    }

    case 'whip': {
      // Ultra-fast whip: translateX(60%) + blur(8px) → clean
      const progress = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: easeOut,
      });
      const translateX = interpolate(progress, [0, 1], [60, 0]);
      const blur = interpolate(progress, [0, 1], [8, 0]);
      return {
        transform: `translateX(${translateX}%)`,
        filter: `blur(${blur}px)`,
      };
    }

    default: {
      // Fallback to fade
      const opacity = interpolate(frame, [0, transitionFrames], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: easeOut,
      });
      return { opacity };
    }
  }
}
