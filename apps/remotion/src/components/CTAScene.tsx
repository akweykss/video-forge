// ============================================================
// CTAScene — Call-to-action with pulsing animation
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

interface CTASceneProps {
  scene: ResolvedScene;
  primaryColor: string;
  secondaryColor: string;
}

export const CTAScene: React.FC<CTASceneProps> = ({
  scene,
  primaryColor,
  secondaryColor,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // === Main CTA text bounce ===
  const ctaProgress = spring({
    frame,
    fps,
    config: springPresets.bouncy,
  });

  const ctaScale = interpolate(ctaProgress, [0, 1], [0.4, 1]);
  const ctaY = interpolate(ctaProgress, [0, 1], [60, 0]);

  // === Subtitle fade ===
  const subtitleProgress = spring({
    frame: Math.max(0, frame - 18),
    fps,
    config: springPresets.smooth,
  });

  // === Pulsing circle ===
  const pulseScale = 1 + Math.sin(frame * 0.08 * Math.PI * 2) * 0.06;
  const pulseOpacity = interpolate(
    Math.sin(frame * 0.08 * Math.PI * 2),
    [-1, 1],
    [0.6, 1],
  );

  // === Ring expansion ===
  const ringScale1 = interpolate(
    frame % 60,
    [0, 60],
    [1, 2.5],
    { extrapolateRight: 'clamp' },
  );
  const ringOpacity1 = interpolate(
    frame % 60,
    [0, 60],
    [0.5, 0],
    { extrapolateRight: 'clamp' },
  );
  const ringScale2 = interpolate(
    (frame + 30) % 60,
    [0, 60],
    [1, 2.5],
    { extrapolateRight: 'clamp' },
  );
  const ringOpacity2 = interpolate(
    (frame + 30) % 60,
    [0, 60],
    [0.5, 0],
    { extrapolateRight: 'clamp' },
  );

  // === Arrow bounce ===
  const arrowY = Math.sin(frame * 0.12) * 12;

  // === Background gradient rotation ===
  const bgAngle = interpolate(
    frame,
    [0, durationInFrames],
    [135, 315],
    { extrapolateRight: 'clamp' },
  );

  const ctaText = scene.headline || 'Inscreva-se Agora!';
  const subtitleText = scene.subtitle || scene.body || '';

  return (
    <AbsoluteFill>
      {/* Vibrant gradient background */}
      <AbsoluteFill
        style={{
          background: gradient(primaryColor, secondaryColor, bgAngle),
        }}
      />

      {/* Dark overlay for depth */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.4) 100%)`,
        }}
      />

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
        {/* Pulsing circle with ripple effect */}
        <div
          style={{
            position: 'relative',
            width: 140,
            height: 140,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 60,
          }}
        >
          {/* Ripple ring 1 */}
          <div
            style={{
              position: 'absolute',
              width: 140,
              height: 140,
              borderRadius: '50%',
              border: `3px solid ${withOpacity('#FFFFFF', ringOpacity1)}`,
              transform: `scale(${ringScale1})`,
            }}
          />
          {/* Ripple ring 2 */}
          <div
            style={{
              position: 'absolute',
              width: 140,
              height: 140,
              borderRadius: '50%',
              border: `3px solid ${withOpacity('#FFFFFF', ringOpacity2)}`,
              transform: `scale(${ringScale2})`,
            }}
          />

          {/* Main pulse circle */}
          <div
            style={{
              width: 140,
              height: 140,
              borderRadius: '50%',
              backgroundColor: withOpacity('#FFFFFF', 0.15),
              backdropFilter: 'blur(10px)',
              border: `2px solid ${withOpacity('#FFFFFF', 0.3)}`,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              transform: `scale(${pulseScale})`,
              opacity: pulseOpacity,
              boxShadow: `0 0 40px ${withOpacity('#FFFFFF', 0.2)}`,
            }}
          >
            {/* Arrow icon */}
            <div
              style={{
                transform: `translateY(${arrowY}px)`,
                fontSize: 56,
                color: '#FFFFFF',
                fontWeight: 700,
              }}
            >
              ▶
            </div>
          </div>
        </div>

        {/* Main CTA text */}
        <div
          style={{
            transform: `translateY(${ctaY}px) scale(${ctaScale})`,
            opacity: ctaProgress,
            textAlign: 'center',
          }}
        >
          <h2
            style={{
              fontFamily: typography.headline,
              fontSize: 72,
              fontWeight: 900,
              color: '#FFFFFF',
              lineHeight: 1.15,
              margin: 0,
              textShadow: '0 4px 30px rgba(0,0,0,0.3)',
              letterSpacing: '-0.02em',
            }}
          >
            {ctaText}
          </h2>
        </div>

        {/* Subtitle */}
        {subtitleText && (
          <div
            style={{
              opacity: subtitleProgress,
              transform: `translateY(${interpolate(subtitleProgress, [0, 1], [20, 0])}px)`,
              marginTop: 28,
              textAlign: 'center',
            }}
          >
            <p
              style={{
                fontFamily: typography.body,
                fontSize: 38,
                fontWeight: 400,
                color: withOpacity('#FFFFFF', 0.85),
                lineHeight: 1.4,
                margin: 0,
                maxWidth: 800,
                textShadow: '0 2px 10px rgba(0,0,0,0.2)',
              }}
            >
              {subtitleText}
            </p>
          </div>
        )}

        {/* Social follow prompt / body text */}
        {scene.body && scene.body !== subtitleText && (
          <div
            style={{
              marginTop: 48,
              opacity: interpolate(frame, [30, 45], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            {/* Social icons placeholder */}
            <div
              style={{
                display: 'flex',
                gap: 20,
              }}
            >
              {['@', '▶', '♥'].map((icon, i) => (
                <div
                  key={i}
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 16,
                    backgroundColor: withOpacity('#FFFFFF', 0.15),
                    backdropFilter: 'blur(8px)',
                    border: `1px solid ${withOpacity('#FFFFFF', 0.2)}`,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    fontSize: 24,
                    color: '#FFFFFF',
                    transform: `scale(${spring({
                      frame: Math.max(0, frame - 35 - i * 5),
                      fps,
                      config: springPresets.bouncy,
                    })})`,
                  }}
                >
                  {icon}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Body text below social icons */}
        {scene.body && scene.body !== subtitleText && (
          <div
            style={{
              marginTop: 20,
              opacity: interpolate(frame, [40, 55], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
            }}
          >
            <p
              style={{
                fontFamily: typography.ui,
                fontSize: 32,
                fontWeight: 500,
                color: withOpacity('#FFFFFF', 0.7),
                margin: 0,
                textAlign: 'center',
              }}
            >
              {scene.body}
            </p>
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
