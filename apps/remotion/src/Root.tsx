// ============================================================
// Root — Remotion Studio entry point
// ============================================================
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { ResolvedVideoManifest } from '@video-forge/shared';
import { VideoComposition } from './VideoComposition';

// Load Google Fonts for professional typography
import { loadFont as loadPlayfair } from '@remotion/google-fonts/PlayfairDisplay';
import { loadFont as loadMerriweather } from '@remotion/google-fonts/Merriweather';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';

loadPlayfair();
loadMerriweather();
loadInter();

/**
 * Default props for Remotion Studio preview.
 * This sample manifest lets you preview all scene types without needing
 * the full pipeline to generate a real manifest.
 */
const defaultProps: ResolvedVideoManifest = {
  meta: {
    title: 'Aposentadoria: O Que Você Precisa Saber',
    description: 'Guia completo sobre planejamento de aposentadoria no Brasil',
    language: 'pt-BR',
    fps: 30,
    width: 1080,
    height: 1920,
  },
  style: {
    primaryColor: '#4F7BFF',
    secondaryColor: '#8B5CF6',
    backgroundColor: '#0A0A0F',
    fontFamily: 'Inter',
    mood: 'informativo',
  },
  scenes: [
    {
      id: 'scene-01',
      type: 'hero',
      durationInSeconds: 5,
      durationInFrames: 150,
      headline: 'Aposentadoria no Brasil',
      subtitle: 'O guia definitivo para planejar seu futuro',
      visualType: 'animation_only',
      animation: 'bounce',
      transition: 'fade',
      transitionDurationFrames: 15,
      assetUrl: '',
    },
    {
      id: 'scene-02',
      type: 'content',
      durationInSeconds: 6,
      durationInFrames: 180,
      headline: 'Quando posso me aposentar?',
      body: 'A idade mínima para aposentadoria por idade é de 65 anos para homens e 62 para mulheres.',
      visualType: 'text_card',
      animation: 'slide-left',
      transition: 'slide',
      transitionDurationFrames: 15,
      assetUrl: '',
    },
    {
      id: 'scene-03',
      type: 'statistic',
      durationInSeconds: 5,
      durationInFrames: 150,
      headline: '97%',
      body: 'dos brasileiros não planejam a aposentadoria adequadamente',
      visualType: 'animation_only',
      animation: 'zoom-in',
      transition: 'fade',
      transitionDurationFrames: 15,
      assetUrl: '',
    },
    {
      id: 'scene-04',
      type: 'quote',
      durationInSeconds: 6,
      durationInFrames: 180,
      body: 'O melhor momento para começar a planejar sua aposentadoria foi há 20 anos. O segundo melhor momento é agora.',
      subtitle: 'Provérbio Financeiro',
      visualType: 'text_card',
      animation: 'kinetic-text',
      transition: 'dissolve',
      transitionDurationFrames: 15,
      assetUrl: '',
    },
    {
      id: 'scene-05',
      type: 'content',
      durationInSeconds: 5,
      durationInFrames: 150,
      headline: 'INSS vs Previdência Privada',
      body: 'Combine ambas as opções para garantir uma renda confortável na aposentadoria.',
      visualType: 'text_card',
      animation: 'slide-right',
      transition: 'wipe',
      transitionDurationFrames: 15,
      assetUrl: '',
    },
    {
      id: 'scene-06',
      type: 'cta',
      durationInSeconds: 5,
      durationInFrames: 150,
      headline: 'Comece Agora!',
      subtitle: 'Siga para mais dicas sobre aposentadoria',
      body: '@seucanal',
      visualType: 'animation_only',
      animation: 'bounce',
      transition: 'fade',
      transitionDurationFrames: 15,
      assetUrl: '',
    },
  ],
  totalDurationInFrames: 960,
};

/**
 * calculateMetadata computes the total duration from scene data.
 * Uses absolute positioning — total = max(scene.startFrame + scene.durationInFrames)
 */
const calculateMetadata = async ({
  props,
}: {
  props: ResolvedVideoManifest;
}) => {
  // With absolute positioning, total duration = furthest endpoint
  let maxEndFrame = 0;
  for (const scene of props.scenes) {
    const startFrame = (scene as any).startFrame || 0;
    const endFrame = startFrame + scene.durationInFrames;
    if (endFrame > maxEndFrame) maxEndFrame = endFrame;
  }

  // Use manifest's totalDurationInFrames if available (based on audio length)
  const totalFrames = Math.max(
    maxEndFrame,
    props.totalDurationInFrames || 0,
    30, // Minimum 1 second
  );

  return {
    durationInFrames: totalFrames,
    fps: props.meta.fps || 30,
    width: props.meta.width || 1080,
    height: props.meta.height || 1920,
  };
};

// Editor wrapper that always shows SceneInspector
import { SceneInspector } from './components/SceneInspector';

const VideoEditor: React.FC<ResolvedVideoManifest> = (manifest) => {
  return (
    <>
      <VideoComposition {...manifest} />
      <SceneInspector scenes={manifest.scenes} style={manifest.style} />
    </>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Main composition — for rendering (no inspector) */}
      <Composition
        id="VideoComposition"
        component={VideoComposition}
        durationInFrames={960}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />

      {/* Editor composition — for Studio preview (with inspector) */}
      <Composition
        id="VideoEditor"
        component={VideoEditor}
        durationInFrames={960}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
    </>
  );
};

registerRoot(RemotionRoot);
