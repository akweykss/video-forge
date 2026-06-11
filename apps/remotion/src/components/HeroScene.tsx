// ============================================================
// HeroScene — Opening scene with animated title & gradient BG
// ============================================================
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from 'remotion';
import type { ResolvedScene } from '@video-forge/shared';
import { MediaAsset } from './MediaAsset';
import { springPresets } from '../utils/animations';
import { gradient, withOpacity, palette, typography } from '../utils/colors';

interface HeroSceneProps {
  scene: ResolvedScene;
  primaryColor: string;
  secondaryColor: string;
}

/**
 * Animated floating dot for visual interest
 */
const FloatingDot: React.FC<{
  x: number;
  y: number;
  size: number;
  delay: number;
  color: string;
}> = ({ x, y, size, delay, color }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: springPresets.slow,
  });

  // Gentle floating motion
  const floatY = Math.sin((frame + delay) * 0.03) * 15;
  const floatX = Math.cos((frame + delay) * 0.02) * 10;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
        opacity: progress * 0.4,
        transform: `translate(${floatX}px, ${floatY}px) scale(${progress})`,
        filter: `blur(${size > 20 ? 4 : 1}px)`,
      }}
    />
  );
};

export const HeroScene: React.FC<HeroSceneProps> = ({
  scene,
  primaryColor,
  secondaryColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // === Title animation: spring bounce ===
  const titleProgress = spring({
    frame,
    fps,
    config: springPresets.bouncy,
  });

  const titleScale = interpolate(titleProgress, [0, 1], [0.3, 1]);
  const titleOpacity = titleProgress;
  const titleY = interpolate(titleProgress, [0, 1], [80, 0]);

  // === Subtitle animation: delayed fade + slide ===
  const subtitleProgress = spring({
    frame: Math.max(0, frame - 15),
    fps,
    config: springPresets.smooth,
  });

  const subtitleOpacity = subtitleProgress;
  const subtitleY = interpolate(subtitleProgress, [0, 1], [40, 0]);

  // === Background gradient rotation ===
  const gradientAngle = interpolate(
    frame,
    [0, durationInFrames],
    [135, 225],
    { extrapolateRight: 'clamp' },
  );

  // === Decorative line animation ===
  const lineWidth = interpolate(
    frame,
    [10, 35],
    [0, 200],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // Pre-computed dot positions for visual interest
  const dots = [
    { x: 120, y: 280, size: 24, delay: 5, color: withOpacity(primaryColor, 0.6) },
    { x: 820, y: 450, size: 16, delay: 10, color: withOpacity(secondaryColor, 0.5) },
    { x: 200, y: 1400, size: 32, delay: 8, color: withOpacity(primaryColor, 0.3) },
    { x: 900, y: 1200, size: 20, delay: 12, color: withOpacity(secondaryColor, 0.4) },
    { x: 500, y: 300, size: 12, delay: 15, color: withOpacity(primaryColor, 0.5) },
    { x: 150, y: 900, size: 28, delay: 6, color: withOpacity(secondaryColor, 0.3) },
    { x: 750, y: 1600, size: 18, delay: 18, color: withOpacity(primaryColor, 0.4) },
    { x: 950, y: 800, size: 14, delay: 20, color: withOpacity(secondaryColor, 0.5) },
  ];

  return (
    <AbsoluteFill>
      {/* Gradient background */}
      <AbsoluteFill
        style={{
          background: gradient(
            withOpacity(primaryColor, 0.9),
            withOpacity(secondaryColor, 0.9),
            gradientAngle,
          ),
        }}
      />

      {/* Dark base for depth */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 30% 40%, transparent 20%, ${palette.bg.primary}88 80%)`,
        }}
      />

      {/* Optional background image */}
      {scene.assetUrl && scene.visualType !== 'text_card' && scene.visualType !== 'animation_only' && (
        <>
          <AbsoluteFill style={{ overflow: 'hidden' }}>
            <MediaAsset
              src={scene.assetUrl}
              style={{
                opacity: 0.25,
                filter: 'blur(2px)',
              }}
            />
          </AbsoluteFill>
          <AbsoluteFill
            style={{
              background: `linear-gradient(180deg, ${withOpacity(primaryColor, 0.8)} 0%, ${palette.bg.primary}CC 50%, ${withOpacity(secondaryColor, 0.8)} 100%)`,
            }}
          />
        </>
      )}

      {/* Floating dots */}
      {dots.map((dot, i) => (
        <FloatingDot key={i} {...dot} />
      ))}

      {/* Content container */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '60px 70px',
        }}
      >
        {/* Decorative accent line */}
        <div
          style={{
            width: lineWidth,
            height: 4,
            background: gradient(primaryColor, secondaryColor, 90),
            borderRadius: 2,
            marginBottom: 48,
          }}
        />

        {/* Main title */}
        <div
          style={{
            transform: `translateY(${titleY}px) scale(${titleScale})`,
            opacity: titleOpacity,
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              fontFamily: typography.headline,
              fontSize: 82,
              fontWeight: 900,
              color: palette.text.primary,
              lineHeight: 1.1,
              margin: 0,
              textShadow: '0 4px 30px rgba(0,0,0,0.4)',
              letterSpacing: '-0.02em',
            }}
          >
            {scene.headline || 'VideoForge'}
          </h1>
        </div>

        {/* Subtitle */}
        {scene.subtitle && (
          <div
            style={{
              transform: `translateY(${subtitleY}px)`,
              opacity: subtitleOpacity,
              marginTop: 32,
              textAlign: 'center',
            }}
          >
            <p
              style={{
                fontFamily: typography.body,
                fontSize: 38,
                fontWeight: 400,
                color: palette.text.secondary,
                lineHeight: 1.4,
                margin: 0,
                maxWidth: 800,
                textShadow: '0 2px 20px rgba(0,0,0,0.3)',
              }}
            >
              {scene.subtitle}
            </p>
          </div>
        )}

        {/* Body text */}
        {scene.body && (
          <div
            style={{
              opacity: interpolate(frame, [25, 45], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
              transform: `translateY(${interpolate(frame, [25, 45], [20, 0], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })}px)`,
              marginTop: 24,
              textAlign: 'center',
            }}
          >
            <p
              style={{
                fontFamily: typography.body,
                fontSize: 36,
                fontWeight: 300,
                color: withOpacity(palette.text.primary, 0.7),
                lineHeight: 1.5,
                margin: 0,
                maxWidth: 750,
              }}
            >
              {scene.body}
            </p>
          </div>
        )}

        {/* Bottom decorative line */}
        <div
          style={{
            width: lineWidth * 0.5,
            height: 4,
            background: gradient(secondaryColor, primaryColor, 90),
            borderRadius: 2,
            marginTop: 48,
            opacity: subtitleOpacity,
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
