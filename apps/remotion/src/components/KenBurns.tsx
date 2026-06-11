// ============================================================
// KenBurns — Reusable Ken Burns zoom/pan effect on images
// ============================================================
import React from 'react';
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

type KenBurnsDirection = 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right';

interface KenBurnsProps {
  /** Image source URL */
  src: string;
  /** Direction of the Ken Burns effect */
  direction?: KenBurnsDirection;
  /** Intensity: 1 = subtle, 2 = medium, 3 = dramatic */
  intensity?: 1 | 2 | 3;
  /** Optional dark overlay opacity for text readability (0-1) */
  overlayOpacity?: number;
  /** Children rendered on top of the image */
  children?: React.ReactNode;
}

export const KenBurns: React.FC<KenBurnsProps> = ({
  src,
  direction = 'zoom-in',
  intensity = 2,
  overlayOpacity = 0,
  children,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // Scale factors based on intensity
  const scaleRange: Record<number, [number, number]> = {
    1: [1.0, 1.08],
    2: [1.0, 1.15],
    3: [1.0, 1.25],
  };

  const panDistance: Record<number, number> = {
    1: 30,
    2: 60,
    3: 100,
  };

  let scale: number;
  let translateX = 0;
  let translateY = 0;

  switch (direction) {
    case 'zoom-in': {
      const [from, to] = scaleRange[intensity];
      scale = interpolate(frame, [0, durationInFrames], [from, to], {
        extrapolateRight: 'clamp',
      });
      break;
    }
    case 'zoom-out': {
      const [from, to] = scaleRange[intensity];
      scale = interpolate(frame, [0, durationInFrames], [to, from], {
        extrapolateRight: 'clamp',
      });
      break;
    }
    case 'pan-left': {
      scale = 1.15;
      const dist = panDistance[intensity];
      translateX = interpolate(frame, [0, durationInFrames], [dist, -dist], {
        extrapolateRight: 'clamp',
      });
      translateY = interpolate(frame, [0, durationInFrames], [-10, 10], {
        extrapolateRight: 'clamp',
      });
      break;
    }
    case 'pan-right': {
      scale = 1.15;
      const dist = panDistance[intensity];
      translateX = interpolate(frame, [0, durationInFrames], [-dist, dist], {
        extrapolateRight: 'clamp',
      });
      translateY = interpolate(frame, [0, durationInFrames], [10, -10], {
        extrapolateRight: 'clamp',
      });
      break;
    }
    default:
      scale = 1;
  }

  return (
    <AbsoluteFill>
      {/* Ken Burns image layer */}
      <AbsoluteFill
        style={{
          overflow: 'hidden',
        }}
      >
        <Img
          src={src}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${scale}) translate(${translateX}px, ${translateY}px)`,
            willChange: 'transform',
          }}
        />
      </AbsoluteFill>

      {/* Dark overlay for text readability */}
      {overlayOpacity > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(0, 0, 0, ${overlayOpacity})`,
          }}
        />
      )}

      {/* Children on top */}
      {children && <AbsoluteFill>{children}</AbsoluteFill>}
    </AbsoluteFill>
  );
};
