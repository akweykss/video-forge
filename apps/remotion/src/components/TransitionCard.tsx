// ============================================================
// TransitionCard — Transition card between sections
// ============================================================
import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from 'remotion';
import type { ResolvedScene } from '@video-forge/shared';
import { springPresets } from '../utils/animations';
import { palette, gradient, withOpacity, typography } from '../utils/colors';

interface TransitionCardProps {
  scene: ResolvedScene;
  primaryColor: string;
  secondaryColor: string;
}

export const TransitionCard: React.FC<TransitionCardProps> = ({
  scene,
  primaryColor,
  secondaryColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // === Text entrance ===
  const textProgress = spring({
    frame: Math.max(0, frame - 5),
    fps,
    config: springPresets.smooth,
  });

  // === Line animation ===
  const lineWidth = interpolate(
    frame,
    [0, 25],
    [0, 160],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // === Background subtle movement ===
  const bgShift = interpolate(
    frame,
    [0, durationInFrames],
    [0, 30],
    { extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill>
      {/* Dark background */}
      <AbsoluteFill style={{ backgroundColor: palette.bg.secondary }} />

      {/* Subtle gradient accent */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at ${50 + bgShift}% 50%, ${withOpacity(primaryColor, 0.1)} 0%, transparent 60%)`,
        }}
      />

      {/* Content */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '60px 80px',
        }}
      >
        {/* Top accent line */}
        <div
          style={{
            width: lineWidth,
            height: 3,
            background: gradient(primaryColor, secondaryColor, 90),
            borderRadius: 2,
            marginBottom: 40,
          }}
        />

        {/* Headline */}
        {scene.headline && (
          <div
            style={{
              opacity: textProgress,
              transform: `translateY(${interpolate(textProgress, [0, 1], [30, 0])}px) scale(${interpolate(textProgress, [0, 1], [0.95, 1])})`,
              textAlign: 'center',
            }}
          >
            <h2
              style={{
                fontFamily: typography.headline,
                fontSize: 56,
                fontWeight: 800,
                color: palette.text.primary,
                lineHeight: 1.2,
                margin: 0,
              }}
            >
              {scene.headline}
            </h2>
          </div>
        )}

        {/* Subtitle */}
        {scene.subtitle && (
          <div
            style={{
              opacity: interpolate(frame, [20, 35], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
              marginTop: 20,
            }}
          >
            <p
              style={{
                fontFamily: typography.body,
                fontSize: 34,
                fontWeight: 400,
                color: palette.text.muted,
                margin: 0,
                textAlign: 'center',
              }}
            >
              {scene.subtitle}
            </p>
          </div>
        )}

        {/* Bottom accent line */}
        <div
          style={{
            width: lineWidth * 0.6,
            height: 3,
            background: gradient(secondaryColor, primaryColor, 90),
            borderRadius: 2,
            marginTop: 40,
            opacity: interpolate(frame, [10, 30], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
