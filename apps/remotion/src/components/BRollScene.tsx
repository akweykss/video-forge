// ============================================================
// BRollScene — Full-screen video/image with documentary-style text overlay
// Features: Ken Burns on ALL media, glassmorphism lower third, vignette
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
import { MediaAsset } from './MediaAsset';
import { LowerThird } from './LowerThird';
import { springPresets } from '../utils/animations';
import { palette, vignetteGradient, withOpacity } from '../utils/colors';

interface BRollSceneProps {
  scene: ResolvedScene;
  primaryColor: string;
}

export const BRollScene: React.FC<BRollSceneProps> = ({
  scene,
  primaryColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Determine title/subtitle for lower third
  const lowerThirdTitle = scene.headline || scene.body || '';
  const lowerThirdSubtitle = scene.subtitle || '';

  // Cycle through Ken Burns effects for variety
  const kenBurnsEffects = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right'] as const;
  const sceneNum = parseInt(scene.id?.replace(/\D/g, '') || '0');
  const kenBurnsEffect = kenBurnsEffects[sceneNum % kenBurnsEffects.length];

  return (
    <AbsoluteFill>
      {/* Background: Video or Image with Ken Burns */}
      {scene.assetUrl ? (
        <MediaAsset
          src={scene.assetUrl}
          kenBurns={kenBurnsEffect}
          intensity={2}
        />
      ) : (
        <AbsoluteFill style={{ backgroundColor: palette.bg.primary }} />
      )}

      {/* Vignette overlay on edges */}
      <AbsoluteFill
        style={{
          background: vignetteGradient(0.7),
          pointerEvents: 'none',
        }}
      />

      {/* Bottom gradient for text readability */}
      <AbsoluteFill
        style={{
          background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.85) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Top gradient */}
      <AbsoluteFill
        style={{
          background: 'linear-gradient(0deg, transparent 70%, rgba(0,0,0,0.4) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Documentary-style lower third */}
      {lowerThirdTitle && (
        <LowerThird
          title={lowerThirdTitle}
          subtitle={lowerThirdSubtitle}
          position="bottom-left"
          accentColor={primaryColor}
          delay={5}
        />
      )}
    </AbsoluteFill>
  );
};
