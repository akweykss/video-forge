/**
 * Etapa 3: Planejamento de Cenas
 * Usa Claude para gerar o VideoManifest JSON completo
 */

import { planScenes, type ContentAnalysis } from '@video-forge/integrations';
import { validateManifest, validateDuration, validateAssetRequirements } from '@video-forge/shared';
import type { VideoManifest } from '@video-forge/shared';
import { PipelineLogger } from '../utils/logger';

export interface PlanScenesStepResult {
  manifest: VideoManifest;
}

const MAX_RETRIES = 3;

/**
 * Executa o planejamento de cenas
 * Gera o VideoManifest e valida com Zod
 * Retry automático se a validação falhar
 */
export async function executePlanScenes(
  analysis: ContentAnalysis,
  audioDurationSeconds: number,
  logger: PipelineLogger,
): Promise<PlanScenesStepResult> {
  logger.info(`Planejando cenas para ${audioDurationSeconds.toFixed(1)}s de áudio...`);

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Tentativa ${attempt}/${MAX_RETRIES}...`);

      // Claude gera o VideoManifest
      const rawManifest = await planScenes(analysis, audioDurationSeconds);

      // Validação com Zod
      const validation = validateManifest(rawManifest);
      if (!validation.success) {
        lastError = `Validação Zod falhou: ${validation.errors?.join('; ')}`;
        logger.warn(lastError);
        continue;
      }

      const manifest = validation.data!;

      // Validação de duração
      const durationCheck = validateDuration(manifest, audioDurationSeconds + 5);
      if (!durationCheck.valid) {
        lastError = durationCheck.message!;
        logger.warn(lastError);
        continue;
      }

      // Validação de requisitos de assets
      const assetCheck = validateAssetRequirements(manifest);
      if (!assetCheck.valid) {
        lastError = `Assets inválidos: ${assetCheck.issues.join('; ')}`;
        logger.warn(lastError);
        continue;
      }

      logger.success(
        `Planejamento concluído: ${manifest.scenes.length} cenas, ` +
        `${durationCheck.totalSeconds.toFixed(1)}s total`,
      );

      // Log das cenas
      manifest.scenes.forEach((scene, i) => {
        logger.info(
          `  Cena ${i + 1}: [${scene.type}] ${scene.durationInSeconds}s - ` +
          `${scene.visualType} - ${scene.animation}`,
        );
      });

      return { manifest };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Erro desconhecido';
      logger.warn(`Tentativa ${attempt} falhou: ${lastError}`);
    }
  }

  throw new Error(
    `Falha ao planejar cenas após ${MAX_RETRIES} tentativas. Último erro: ${lastError}`,
  );
}
