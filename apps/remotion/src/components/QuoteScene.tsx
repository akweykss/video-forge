// ============================================================
// QuoteScene — Highlighted quote with kinetic text animation
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
import { KineticText } from './KineticText';
import { springPresets } from '../utils/animations';
import { palette, gradient, withOpacity, typography } from '../utils/colors';

interface QuoteSceneProps {
  scene: ResolvedScene;
  primaryColor: string;
  secondaryColor: string;
}

export const QuoteScene: React.FC<QuoteSceneProps> = ({
  scene,
  primaryColor,
  secondaryColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // === Quotation mark animation ===
  const quoteMarkProgress = spring({
    frame,
    fps,
    config: springPresets.bouncy,
  });

  // === Author text animation ===
  const authorProgress = spring({
    frame: Math.max(0, frame - 40),
    fps,
    config: springPresets.smooth,
  });

  // === Accent line animation ===
  const lineProgress = interpolate(
    frame,
    [30, 55],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const quoteText = scene.body || scene.headline || '';
  const authorText = scene.subtitle || '';

  return (
    <AbsoluteFill>
      {/* Dark background */}
      <AbsoluteFill
        style={{
          backgroundColor: palette.bg.primary,
        }}
      />

      {/* Subtle radial gradient accent */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 20% 30%, ${withOpacity(primaryColor, 0.12)} 0%, transparent 60%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 80% 80%, ${withOpacity(secondaryColor, 0.08)} 0%, transparent 50%)`,
        }}
      />

      {/* Content container */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '120px 80px',
        }}
      >
        {/* Opening quotation mark */}
        <div
          style={{
            fontFamily: 'Georgia, serif',
            fontSize: 200,
            fontWeight: 700,
            color: primaryColor,
            lineHeight: 0.6,
            opacity: quoteMarkProgress * 0.3,
            transform: `scale(${interpolate(quoteMarkProgress, [0, 1], [0.5, 1])})`,
            marginBottom: 20,
            textShadow: `0 0 60px ${withOpacity(primaryColor, 0.3)}`,
          }}
        >
          &ldquo;
        </div>

        {/* Quote text with kinetic animation */}
        <div style={{ maxWidth: 900, textAlign: 'center' }}>
          <KineticText
            text={quoteText}
            fontSize={52}
            fontWeight={600}
            color={palette.text.primary}
            style="bounce"
            mode="word"
            staggerDelay={4}
            delay={8}
            lineHeight={1.45}
            textAlign="center"
          />
        </div>

        {/* Closing quotation mark */}
        <div
          style={{
            fontFamily: 'Georgia, serif',
            fontSize: 200,
            fontWeight: 700,
            color: secondaryColor,
            lineHeight: 0.6,
            opacity: quoteMarkProgress * 0.3,
            transform: `scale(${interpolate(quoteMarkProgress, [0, 1], [0.5, 1])}) rotate(180deg)`,
            marginTop: 20,
            textShadow: `0 0 60px ${withOpacity(secondaryColor, 0.3)}`,
          }}
        >
          &ldquo;
        </div>

        {/* Gradient accent line */}
        <div
          style={{
            width: interpolate(lineProgress, [0, 1], [0, 240]),
            height: 3,
            background: gradient(primaryColor, secondaryColor, 90),
            borderRadius: 2,
            marginTop: 48,
            opacity: lineProgress,
          }}
        />

        {/* Author/source text */}
        {authorText && (
          <div
            style={{
              marginTop: 32,
              opacity: authorProgress,
              transform: `translateY(${interpolate(authorProgress, [0, 1], [20, 0])}px)`,
            }}
          >
            <span
              style={{
                fontFamily: typography.body,
                fontSize: 32,
                fontWeight: 400,
                color: palette.text.muted,
                fontStyle: 'italic',
              }}
            >
              — {authorText}
            </span>
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
