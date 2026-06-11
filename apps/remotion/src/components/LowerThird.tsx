// ============================================================
// LowerThird — Glassmorphism overlay panel with spring animation
// ============================================================
import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { springPresets } from '../utils/animations';
import { palette, typography } from '../utils/colors';

interface LowerThirdProps {
  /** Primary title text */
  title: string;
  /** Secondary subtitle text */
  subtitle?: string;
  /** Position on screen */
  position?: 'bottom-left' | 'bottom-right';
  /** Accent color for left border */
  accentColor?: string;
  /** Delay before animation starts (frames) */
  delay?: number;
  /** Title font size */
  titleFontSize?: number;
  /** Subtitle font size */
  subtitleFontSize?: number;
}

export const LowerThird: React.FC<LowerThirdProps> = ({
  title,
  subtitle,
  position = 'bottom-left',
  accentColor = palette.accent.blue,
  delay = 0,
  titleFontSize = 42,
  subtitleFontSize = 28,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Slide-in animation
  const slideProgress = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: springPresets.smooth,
  });

  const translateX = interpolate(
    slideProgress,
    [0, 1],
    [position === 'bottom-left' ? -600 : 600, 0],
  );

  // Text fade-in (slightly delayed after panel)
  const textOpacity = interpolate(
    frame,
    [delay + 8, delay + 20],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 180,
        left: position === 'bottom-left' ? 40 : undefined,
        right: position === 'bottom-right' ? 40 : undefined,
        transform: `translateX(${translateX}px)`,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        maxWidth: 920,
        borderRadius: 20,
        overflow: 'hidden',
        opacity: slideProgress,
      }}
    >
      {/* Accent border */}
      <div
        style={{
          width: 6,
          backgroundColor: accentColor,
          flexShrink: 0,
          borderRadius: '20px 0 0 20px',
        }}
      />

      {/* Glass panel */}
      <div
        style={{
          backgroundColor: palette.glass.bgStrong,
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: `1px solid ${palette.glass.borderStrong}`,
          borderLeft: 'none',
          borderRadius: '0 20px 20px 0',
          padding: '28px 40px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: typography.headline,
            fontSize: titleFontSize,
            fontWeight: 700,
            color: palette.text.primary,
            opacity: textOpacity,
            lineHeight: 1.2,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              fontFamily: typography.body,
              fontSize: subtitleFontSize,
              fontWeight: 400,
              color: palette.text.secondary,
              opacity: textOpacity,
              lineHeight: 1.3,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
};
