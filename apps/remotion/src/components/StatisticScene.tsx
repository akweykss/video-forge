// ============================================================
// StatisticScene — Animated counter + progress bar
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
import { springPresets, countUp } from '../utils/animations';
import { palette, gradient, withOpacity, radialGradient, typography } from '../utils/colors';

interface StatisticSceneProps {
  scene: ResolvedScene;
  primaryColor: string;
  secondaryColor: string;
}

/**
 * Extracts numeric value and unit from headline text.
 * Examples: "97%" → { value: 97, unit: "%" }
 *           "R$ 5.000" → { value: 5000, unit: "R$", prefix: true }
 *           "3.5 milhões" → { value: 3.5, unit: "milhões", suffix: true }
 */
function parseStatistic(text: string): {
  value: number;
  unit: string;
  isPrefix: boolean;
  decimals: number;
} {
  // Handle R$ prefix
  const rMatch = text.match(/R\$\s*([\d.,]+)/);
  if (rMatch) {
    const num = parseFloat(rMatch[1].replace(/\./g, '').replace(',', '.'));
    return { value: num, unit: 'R$', isPrefix: true, decimals: num % 1 !== 0 ? 2 : 0 };
  }

  // Handle percentage
  const pMatch = text.match(/([\d.,]+)\s*%/);
  if (pMatch) {
    const num = parseFloat(pMatch[1].replace(',', '.'));
    return { value: num, unit: '%', isPrefix: false, decimals: num % 1 !== 0 ? 1 : 0 };
  }

  // Handle generic number + text unit
  const gMatch = text.match(/([\d.,]+)\s*(.+)?/);
  if (gMatch) {
    const num = parseFloat(gMatch[1].replace(/\./g, '').replace(',', '.'));
    const unit = gMatch[2]?.trim() || '';
    return { value: num, unit, isPrefix: false, decimals: num % 1 !== 0 ? 1 : 0 };
  }

  return { value: 0, unit: '', isPrefix: false, decimals: 0 };
}

/**
 * Formats a number with thousands separators (Brazilian format).
 */
function formatNumber(num: number, decimals: number): string {
  const parts = num.toFixed(decimals).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return parts.join(',');
}

export const StatisticScene: React.FC<StatisticSceneProps> = ({
  scene,
  primaryColor,
  secondaryColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const stat = parseStatistic(scene.headline || '0');

  // === Number counting animation ===
  const currentValue = countUp(frame, stat.value, 8, 50);
  const displayNumber = formatNumber(
    Math.min(currentValue, stat.value),
    stat.decimals,
  );

  // === Container scale-in ===
  const containerProgress = spring({
    frame,
    fps,
    config: springPresets.smooth,
  });

  // === Number bounce ===
  const numberProgress = spring({
    frame: Math.max(0, frame - 5),
    fps,
    config: springPresets.bouncy,
  });

  // === Label fade-in ===
  const labelOpacity = interpolate(
    frame,
    [20, 40],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const labelY = interpolate(
    frame,
    [20, 40],
    [30, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // === Progress bar animation ===
  const barProgress = interpolate(
    frame,
    [15, 55],
    [0, Math.min(stat.value, 100) / 100],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // === Circular progress (for percentages) ===
  const isPercentage = stat.unit === '%';
  const circleRadius = 160;
  const circumference = 2 * Math.PI * circleRadius;
  const circleOffset = circumference * (1 - barProgress);

  return (
    <AbsoluteFill>
      {/* Dark background */}
      <AbsoluteFill style={{ backgroundColor: palette.bg.primary }} />

      {/* Gradient accent glow */}
      <AbsoluteFill
        style={{
          background: radialGradient(
            withOpacity(primaryColor, 0.15),
            'transparent',
            'center 45%',
          ),
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
          opacity: containerProgress,
          transform: `scale(${interpolate(containerProgress, [0, 1], [0.9, 1])})`,
        }}
      >
        {/* Circular progress ring (for percentages) */}
        {isPercentage && (
          <div
            style={{
              position: 'relative',
              width: circleRadius * 2 + 40,
              height: circleRadius * 2 + 40,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 40,
            }}
          >
            {/* SVG ring */}
            <svg
              width={circleRadius * 2 + 40}
              height={circleRadius * 2 + 40}
              style={{ position: 'absolute', transform: 'rotate(-90deg)' }}
            >
              {/* Background ring */}
              <circle
                cx={circleRadius + 20}
                cy={circleRadius + 20}
                r={circleRadius}
                fill="none"
                stroke={withOpacity(palette.text.primary, 0.08)}
                strokeWidth={10}
              />
              {/* Progress ring */}
              <circle
                cx={circleRadius + 20}
                cy={circleRadius + 20}
                r={circleRadius}
                fill="none"
                stroke={primaryColor}
                strokeWidth={10}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circleOffset}
              />
            </svg>

            {/* Number inside ring */}
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 4,
                transform: `scale(${numberProgress})`,
              }}
            >
              <span
                style={{
                  fontFamily: typography.ui,
                  fontSize: 100,
                  fontWeight: 900,
                  color: palette.text.primary,
                  letterSpacing: '-0.03em',
                }}
              >
                {displayNumber}
              </span>
              <span
                style={{
                  fontFamily: typography.ui,
                  fontSize: 52,
                  fontWeight: 700,
                  color: primaryColor,
                }}
              >
                {stat.unit}
              </span>
            </div>
          </div>
        )}

        {/* Non-percentage: large number display */}
        {!isPercentage && (
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 16,
              transform: `scale(${numberProgress})`,
              marginBottom: 20,
            }}
          >
            {stat.isPrefix && (
              <span
                style={{
                  fontFamily: typography.ui,
                  fontSize: 52,
                  fontWeight: 700,
                  color: primaryColor,
                }}
              >
                {stat.unit}
              </span>
            )}
            <span
              style={{
                fontFamily: typography.ui,
                fontSize: 120,
                fontWeight: 900,
                color: palette.text.primary,
                letterSpacing: '-0.03em',
                textShadow: `0 0 80px ${withOpacity(primaryColor, 0.3)}`,
              }}
            >
              {displayNumber}
            </span>
            {!stat.isPrefix && stat.unit && (
              <span
                style={{
                  fontFamily: typography.ui,
                  fontSize: 48,
                  fontWeight: 600,
                  color: primaryColor,
                }}
              >
                {stat.unit}
              </span>
            )}
          </div>
        )}

        {/* Horizontal progress bar (for non-percentage values, capped at 100%) */}
        {!isPercentage && (
          <div
            style={{
              width: '80%',
              maxWidth: 700,
              height: 12,
              backgroundColor: withOpacity(palette.text.primary, 0.08),
              borderRadius: 6,
              overflow: 'hidden',
              marginBottom: 40,
            }}
          >
            <div
              style={{
                width: `${barProgress * 100}%`,
                height: '100%',
                background: gradient(primaryColor, secondaryColor, 90),
                borderRadius: 6,
                boxShadow: `0 0 20px ${withOpacity(primaryColor, 0.4)}`,
              }}
            />
          </div>
        )}

        {/* Label / description text */}
        {scene.body && (
          <div
            style={{
              opacity: labelOpacity,
              transform: `translateY(${labelY}px)`,
              textAlign: 'center',
            }}
          >
            <p
              style={{
                fontFamily: typography.ui,
                fontSize: 40,
                fontWeight: 500,
                color: palette.text.secondary,
                lineHeight: 1.4,
                margin: 0,
                maxWidth: 800,
              }}
            >
              {scene.body}
            </p>
          </div>
        )}

        {/* Subtitle */}
        {scene.subtitle && (
          <div
            style={{
              opacity: interpolate(frame, [35, 50], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
              marginTop: 16,
            }}
          >
            <p
              style={{
                fontFamily: typography.ui,
                fontSize: 32,
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
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
