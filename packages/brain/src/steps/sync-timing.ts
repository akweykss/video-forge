/**
 * Etapa 6: Sincronização de Timing
 * Alinha as cenas do VideoManifest com os timestamps do áudio
 * Calcula durationInFrames preciso para cada cena
 */

import {
  secondsToFrames,
  msToFrames,
  type VideoManifest,
  type ResolvedVideoManifest,
  type ResolvedScene,
} from '@video-forge/shared';
import { PipelineLogger } from '../utils/logger';
import type { GeneratedAsset } from './generate-assets';
import type { TranscribeStepResult } from './transcribe';

export interface SyncTimingStepResult {
  resolvedManifest: ResolvedVideoManifest;
}

/**
 * Executa a sincronização de timing entre áudio e cenas
 * - Usa word timestamps para alinhar cenas com a narração
 * - Calcula durationInFrames preciso para cada cena
 * - Associa assets locais às cenas
 */
export async function executeSyncTiming(
  manifest: VideoManifest,
  transcription: TranscribeStepResult,
  assets: GeneratedAsset[],
  audioPath: string,
  logger: PipelineLogger,
): Promise<SyncTimingStepResult> {
  logger.info('Sincronizando timing das cenas com áudio...');

  const fps = manifest.meta.fps;
  const assetMap = new Map(assets.map((a) => [a.sceneId, a]));

  // Calcula duração baseada nos timestamps de narração quando disponíveis
  const resolvedScenes: ResolvedScene[] = manifest.scenes.map((scene, index) => {
    let durationInSeconds = scene.durationInSeconds;

    // Se a cena tem timestamps de narração, usa para calcular duração precisa
    if (scene.narrationStartMs !== undefined && scene.narrationEndMs !== undefined) {
      const narrationDuration = (scene.narrationEndMs - scene.narrationStartMs) / 1000;
      // Adiciona padding de 0.5s antes e depois da narração
      durationInSeconds = Math.max(durationInSeconds, narrationDuration + 1.0);
    }

    // Encontra o asset local correspondente
    const asset = assetMap.get(scene.id);
    const assetUrl = asset?.localPath || scene.assetUrl || '';

    const resolved: ResolvedScene = {
      ...scene,
      assetUrl,
      durationInFrames: secondsToFrames(durationInSeconds, fps),
    };

    return resolved;
  });

  // Calcula duração total
  const totalDurationInFrames = resolvedScenes.reduce(
    (sum, scene) => sum + scene.durationInFrames,
    0,
  );

  const resolvedManifest: ResolvedVideoManifest = {
    ...manifest,
    scenes: resolvedScenes,
    totalDurationInFrames,
    localAudioPath: audioPath,
  };

  const totalSeconds = totalDurationInFrames / fps;
  logger.success(
    `Timing sincronizado: ${resolvedScenes.length} cenas, ` +
    `${totalDurationInFrames} frames (${totalSeconds.toFixed(1)}s)`,
  );

  // Log detalhado de cada cena
  let currentFrame = 0;
  resolvedScenes.forEach((scene, i) => {
    const startTime = (currentFrame / fps).toFixed(1);
    const endTime = ((currentFrame + scene.durationInFrames) / fps).toFixed(1);
    logger.info(
      `  Cena ${i + 1}: ${startTime}s → ${endTime}s (${scene.durationInFrames} frames) [${scene.type}]`,
    );
    currentFrame += scene.durationInFrames;
  });

  return { resolvedManifest };
}
