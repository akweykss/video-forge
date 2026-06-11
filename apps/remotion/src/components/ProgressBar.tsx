// ============================================================
// ProgressBar — Video progress indicator at top or bottom
// ============================================================
import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

interface ProgressBarProps {
  /** Bar color or gradient */
  color?: string;
  /** Secondary color for gradient */
  secondaryColor?: string;
  /** Bar height in pixels */
  height?: number;
  /** Position on screen */
  position?: 'top' | 'bottom';
  /** Whether to show a subtle glow */
  glow?: boolean;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  color = '#4F7BFF',
  secondaryColor,
  height = 6,
  position = 'bottom',
  glow = true,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();

  const progress = interpolate(frame, [0, durationInFrames], [0, 100], {
    extrapolateRight: 'clamp',
  });

  const barWidth = (progress / 100) * width;

  const gradientBg = secondaryColor
    ? `linear-gradient(90deg, ${color}, ${secondaryColor})`
    : color;

  return (
    <div
      style={{
        position: 'absolute',
        [position]: 0,
        left: 0,
        width: '100%',
        height,
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        zIndex: 100,
      }}
    >
      {/* Progress fill */}
      <div
        style={{
          width: barWidth,
          height: '100%',
          background: gradientBg,
          borderRadius: position === 'top' ? '0 0 4px 0' : '0 4px 0 0',
          transition: 'none', // No CSS transitions — Remotion handles this
        }}
      />

      {/* Glow effect */}
      {glow && (
        <div
          style={{
            position: 'absolute',
            [position === 'top' ? 'bottom' : 'top']: -height,
            left: 0,
            width: barWidth,
            height: height * 3,
            background: `linear-gradient(${position === 'top' ? '180deg' : '0deg'}, ${color}44, transparent)`,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
};
