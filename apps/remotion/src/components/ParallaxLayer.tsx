// ============================================================
// ParallaxLayer — Multi-depth parallax effect
// ============================================================
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

interface ParallaxLayerProps {
  /** Speed multiplier: < 1 = slower (background), > 1 = faster (foreground) */
  speed?: number;
  /** Direction of parallax movement */
  direction?: 'vertical' | 'horizontal';
  /** Children to apply the parallax effect to */
  children: React.ReactNode;
  /** Additional styles */
  style?: React.CSSProperties;
}

export const ParallaxLayer: React.FC<ParallaxLayerProps> = ({
  speed = 1.0,
  direction = 'vertical',
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // Calculate parallax offset based on speed and frame
  const maxOffset = 80 * speed;

  const offset = interpolate(
    frame,
    [0, durationInFrames],
    [maxOffset, -maxOffset],
    {
      extrapolateRight: 'clamp',
    },
  );

  const transform =
    direction === 'vertical'
      ? `translateY(${offset}px)`
      : `translateX(${offset}px)`;

  return (
    <AbsoluteFill
      style={{
        transform,
        willChange: 'transform',
        ...style,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
