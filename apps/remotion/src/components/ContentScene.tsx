// ============================================================
// ContentScene — Documentary-style content with text over media
// - Light overlay only (don't darken images unnecessarily)
// - Document mode uses narrationText for full 2-3 line text
// - Only darkens when document/headline overlay is showing
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
import { DocumentReveal } from './DocumentReveal';
import { springPresets } from '../utils/animations';
import { palette, textOverlayGradient, withOpacity, typography } from '../utils/colors';

interface ContentSceneProps {
  scene: ResolvedScene;
  primaryColor: string;
  sceneIndex: number;
  totalScenes: number;
}

export const ContentScene: React.FC<ContentSceneProps> = ({
  scene,
  primaryColor,
  sceneIndex,
  totalScenes,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // === Headline animation: fade in with scale ===
  const headlineProgress = spring({
    frame: Math.max(0, frame - 5),
    fps,
    config: springPresets.smooth,
  });

  const headlineScale = interpolate(headlineProgress, [0, 1], [0.85, 1]);
  const headlineOpacity = headlineProgress;

  // Ken Burns direction cycles through scenes
  const kenBurnsDirections = ['zoom-in', 'pan-left', 'zoom-out', 'pan-right'] as const;
  const kbDirection = kenBurnsDirections[sceneIndex % kenBurnsDirections.length];

  const hasMedia = scene.assetUrl &&
    scene.visualType !== 'text_card' &&
    scene.visualType !== 'animation_only';

  // Check if headline has highlighted words (contains **)
  const hasHighlight = scene.headline?.includes('**');
  const hasHeadline = scene.headline && scene.headline.length > 0;

  // Document mode uses narrationText for fuller text, falling back to headline
  const documentText = hasHighlight
    ? scene.headline // headline already contains the full text with ** markers
    : '';

  return (
    <AbsoluteFill>
      {/* Background: Media with Ken Burns (video OR image) */}
      {hasMedia ? (
        <MediaAsset
          src={scene.assetUrl}
          kenBurns={kbDirection}
          intensity={2}
        />
      ) : (
        <AbsoluteFill style={{ backgroundColor: palette.bg.primary }} />
      )}

      {/* Overlay: ONLY darken when there's text/document over it */}
      {/* When just caption (no headline), keep image clear and bright */}
      {hasHeadline && (
        <AbsoluteFill
          style={{
            background: hasHighlight
              ? 'rgba(0,0,0,0.45)' // Document mode: medium dim so paper pops
              : 'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.25) 30%, rgba(0,0,0,0.5) 100%)', // Simple headline: light gradient
            opacity: headlineOpacity,
          }}
        />
      )}

      {/* === DOCUMENT REVEAL MODE (when headline has **highlights**) === */}
      {hasHighlight && documentText && (
        <DocumentReveal
          text={documentText}
          highlightColor={primaryColor}
        />
      )}

      {/* === SIMPLE HEADLINE MODE (no highlights, just emphasis text) === */}
      {hasHeadline && !hasHighlight && (
        <AbsoluteFill
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-start',
            padding: '28% 50px 0',
          }}
        >
          <div
            style={{
              transform: `scale(${headlineScale})`,
              opacity: headlineOpacity,
              textAlign: 'center',
              maxWidth: 920,
            }}
          >
            <h2
              style={{
                fontFamily: typography.headline,
                fontSize: 62,
                fontWeight: 800,
                color: palette.text.primary,
                lineHeight: 1.3,
                margin: 0,
                textShadow: '0 4px 20px rgba(0,0,0,0.8), 0 2px 4px rgba(0,0,0,0.5)',
                textAlign: 'center',
              }}
            >
              {scene.headline}
            </h2>

            {/* Accent line under headline */}
            <div
              style={{
                width: interpolate(frame, [12, 30], [0, 100], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                }),
                height: 4,
                backgroundColor: primaryColor,
                borderRadius: 2,
                marginTop: 16,
                marginLeft: 'auto',
                marginRight: 'auto',
                boxShadow: `0 0 15px ${withOpacity(primaryColor, 0.5)}`,
              }}
            />
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
