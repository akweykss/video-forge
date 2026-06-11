// ============================================================
// VideoComposition — Main composition with ABSOLUTE timeline positioning
// Each scene is placed at its exact narration timestamp
// ============================================================
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  useVideoConfig,
  useCurrentFrame,
  staticFile,
} from 'remotion';
import type { ResolvedVideoManifest, ResolvedScene } from '@video-forge/shared';
import { SyncCaptions } from './components/SyncCaptions';
import { SceneInspector } from './components/SceneInspector';
import { getTransitionStyle, type TransitionType } from './utils/transitions';

/**
 * Converts a path to a Remotion-compatible URL.
 */
function toRemotionUrl(assetPath: string | null | undefined): string {
  if (!assetPath) return '';
  if (assetPath.startsWith('http://') || assetPath.startsWith('https://')) {
    return assetPath;
  }
  return staticFile(assetPath);
}

import { HeroScene } from './components/HeroScene';
import { ContentScene } from './components/ContentScene';
import { QuoteScene } from './components/QuoteScene';
import { BRollScene } from './components/BRollScene';
import { StatisticScene } from './components/StatisticScene';
import { CTAScene } from './components/CTAScene';
import { TransitionCard } from './components/TransitionCard';
import { ProgressBar } from './components/ProgressBar';



/**
 * Renders the appropriate scene component based on scene type.
 */
const SceneRenderer: React.FC<{
  scene: ResolvedScene;
  manifest: ResolvedVideoManifest;
  sceneIndex: number;
}> = ({ scene, manifest, sceneIndex }) => {
  const { primaryColor, secondaryColor } = manifest.style;

  switch (scene.type) {
    case 'hero':
      // Redirect to ContentScene — no more empty gradient screens
      return (
        <ContentScene
          scene={scene}
          primaryColor={primaryColor}
          sceneIndex={sceneIndex}
          totalScenes={manifest.scenes.length}
        />
      );

    case 'content':
      return (
        <ContentScene
          scene={scene}
          primaryColor={primaryColor}
          sceneIndex={sceneIndex}
          totalScenes={manifest.scenes.length}
        />
      );

    case 'quote':
      // Redirect to ContentScene — text over real media, not empty gradient
      return (
        <ContentScene
          scene={scene}
          primaryColor={primaryColor}
          sceneIndex={sceneIndex}
          totalScenes={manifest.scenes.length}
        />
      );

    case 'broll':
      return (
        <BRollScene
          scene={scene}
          primaryColor={primaryColor}
        />
      );

    case 'statistic':
      // Redirect to ContentScene — numbers over real media, not black screen
      return (
        <ContentScene
          scene={scene}
          primaryColor={primaryColor}
          sceneIndex={sceneIndex}
          totalScenes={manifest.scenes.length}
        />
      );

    case 'cta':
      // Redirect to ContentScene — no more empty gradient screens
      return (
        <ContentScene
          scene={scene}
          primaryColor={primaryColor}
          sceneIndex={sceneIndex}
          totalScenes={manifest.scenes.length}
        />
      );

    case 'transition_card':
      // Redirect to ContentScene
      return (
        <ContentScene
          scene={scene}
          primaryColor={primaryColor}
          sceneIndex={sceneIndex}
          totalScenes={manifest.scenes.length}
        />
      );

    default:
      return (
        <ContentScene
          scene={scene}
          primaryColor={primaryColor}
          sceneIndex={sceneIndex}
          totalScenes={manifest.scenes.length}
        />
      );
  }
};

/**
 * Scene with instant fade-in, NO fade-out (prevents black flash between scenes).
 * Next scene simply covers the previous one — no gap.
 */
const FadeScene: React.FC<{
  scene: ResolvedScene;
  manifest: ResolvedVideoManifest;
  sceneIndex: number;
  transitionFrames: number;
}> = ({ scene, manifest, sceneIndex, transitionFrames }) => {
  const frame = useCurrentFrame();

  // Determine transition type from scene data (default: 'fade' for backward compat)
  const transitionType = ((scene as any).transition as TransitionType) || 'fade';
  const transitionStyle = getTransitionStyle(frame, transitionFrames, transitionType);

  return (
    <AbsoluteFill style={transitionStyle}>
      <SceneRenderer
        scene={scene}
        manifest={manifest}
        sceneIndex={sceneIndex}
      />
    </AbsoluteFill>
  );
};

/**
 * Main VideoComposition — uses absolute Sequence positioning.
 * Each scene is placed at its startFrame (calculated from narration timestamps).
 * This ensures perfect audio-visual synchronization.
 */
export const VideoComposition: React.FC<ResolvedVideoManifest> = (manifest) => {
  const { durationInFrames } = useVideoConfig();
  const { style } = manifest;

  // Convert all local paths to Remotion URLs
  const scenes = manifest.scenes.map((scene) => ({
    ...scene,
    assetUrl: toRemotionUrl(scene.assetUrl),
  }));

  // Transition duration in frames (applies to both fade-in and fade-out)
  const TRANSITION_FRAMES = 4; // ~133ms — ultra-fast transitions

  return (
    <AbsoluteFill style={{ backgroundColor: style.backgroundColor || '#0A0A0F' }}>
      {/* === Scenes positioned absolutely on the timeline === */}
      {scenes.map((scene, index) => {
        const startFrame = scene.startFrame || 0;

        return (
          <Sequence
            key={scene.id}
            from={startFrame}
            durationInFrames={scene.durationInFrames}
            name={`${scene.id}-${scene.type}`}
          >
            <FadeScene
              scene={scene}
              manifest={manifest}
              sceneIndex={index}
              transitionFrames={(scene as any).transition === 'cut' ? 1 : TRANSITION_FRAMES}
            />
          </Sequence>
        );
      })}

      {/* === Synchronized captions (word-by-word) === */}
      {manifest.words && manifest.words.length > 0 && (() => {
        // Calculate frame ranges where headline text is showing
        // Captions hide during these ranges to prevent double text
        const hideRanges = scenes
          .filter((s) => s.headline && s.headline.length > 0)
          .map((s) => ({
            startFrame: s.startFrame || 0,
            endFrame: (s.startFrame || 0) + s.durationInFrames,
          }));

        return (
          <SyncCaptions
            words={manifest.words}
            primaryColor="#FACC15"
            maxWordsVisible={3}
            fontSize={58}
            hideRanges={hideRanges}
          />
        );
      })()}

      {/* === Global progress bar === */}
      <ProgressBar
        color={style.primaryColor}
        secondaryColor={style.secondaryColor}
        height={6}
        position="bottom"
        glow
      />

      {/* === Narration audio === */}
      {manifest.localAudioPath && (
        <Audio
          src={toRemotionUrl(manifest.localAudioPath)}
          volume={1}
        />
      )}

      {/* === Background music === */}
      {manifest.localMusicPath && (
        <Audio
          src={toRemotionUrl(manifest.localMusicPath)}
          volume={manifest.backgroundMusicVolume ?? 0.12}
          loop
        />
      )}
      {/* === Scene Inspector (Studio only — not in renders) === */}
      {typeof window !== 'undefined' && window.location.port === '3000' && (
        <SceneInspector scenes={manifest.scenes} style={manifest.style} />
      )}
    </AbsoluteFill>
  );
};
