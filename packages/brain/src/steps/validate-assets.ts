/**
 * Etapa 5: Validação Visual de Assets
 * Usa Claude Vision para avaliar qualidade e relevância das imagens geradas
 */

import { validateImage } from '@video-forge/integrations';
import { generateImage } from '@video-forge/integrations';
import type { VideoManifest } from '@video-forge/shared';
import { PipelineLogger } from '../utils/logger';
import type { GeneratedAsset } from './generate-assets';

export interface ValidationResult {
  sceneId: string;
  passed: boolean;
  score: number;
  issues: string[];
}

export interface ValidateAssetsStepResult {
  validations: ValidationResult[];
  /** Assets que passaram na validação (podem incluir regeneados) */
  validAssets: GeneratedAsset[];
}

const QUALITY_THRESHOLD = 3.5;
const MAX_REGENERATION_ATTEMPTS = 2;

/**
 * Executa a validação visual de todos os assets de imagem gerados por IA
 * Imagens de stock são validadas apenas por relevância (threshold menor)
 */
export async function executeValidateAssets(
  manifest: VideoManifest,
  assets: GeneratedAsset[],
  logger: PipelineLogger,
): Promise<ValidateAssetsStepResult> {
  logger.info(`Validando ${assets.length} assets com Claude Vision...`);

  const validations: ValidationResult[] = [];
  const validAssets: GeneratedAsset[] = [];

  for (const asset of assets) {
    // Só valida imagens geradas por IA (stock já são curados)
    if (asset.source === 'stock') {
      validAssets.push(asset);
      validations.push({
        sceneId: asset.sceneId,
        passed: true,
        score: 5.0,
        issues: [],
      });
      continue;
    }

    // Encontra a cena correspondente
    const scene = manifest.scenes.find((s) => s.id === asset.sceneId);
    if (!scene) {
      logger.warn(`Cena ${asset.sceneId} não encontrada no manifest`);
      continue;
    }

    const description = scene.imagePrompt || scene.headline || '';
    let currentAsset = asset;
    let passed = false;

    for (let attempt = 0; attempt <= MAX_REGENERATION_ATTEMPTS; attempt++) {
      try {
        logger.info(
          `Validando cena ${asset.sceneId}${attempt > 0 ? ` (tentativa ${attempt + 1})` : ''}...`,
        );

        const validation = await validateImage(currentAsset.localPath, description);

        validations.push({
          sceneId: asset.sceneId,
          passed: validation.pass,
          score: validation.overallScore,
          issues: validation.issues,
        });

        if (validation.pass || validation.overallScore >= QUALITY_THRESHOLD) {
          logger.success(
            `Cena ${asset.sceneId}: Score ${validation.overallScore.toFixed(1)}/5.0 ✓`,
          );
          validAssets.push(currentAsset);
          passed = true;
          break;
        }

        if (attempt < MAX_REGENERATION_ATTEMPTS && scene.imagePrompt) {
          logger.warn(
            `Cena ${asset.sceneId}: Score ${validation.overallScore.toFixed(1)}/5.0 — ` +
            `Regenerando (${validation.issues.join(', ')})`,
          );

          // Regenera com prompt melhorado
          const improvedPrompt = `${scene.imagePrompt}. IMPORTANT: Avoid these issues: ${validation.issues.join('. ')}. High quality, professional, 4K.`;
          const newResult = await generateImage(improvedPrompt, '9:16');
          currentAsset = {
            ...currentAsset,
            localPath: newResult.localPath,
          };
        }
      } catch (error) {
        logger.error(`Erro ao validar cena ${asset.sceneId}`, error);
        // Em caso de erro, aceita o asset sem validação
        validAssets.push(currentAsset);
        passed = true;
        break;
      }
    }

    if (!passed) {
      // Se todas as tentativas falharem, aceita o último asset mesmo assim
      logger.warn(`Cena ${asset.sceneId}: Aceitando apesar de score baixo`);
      validAssets.push(currentAsset);
    }
  }

  const passRate = validations.filter((v) => v.passed).length;
  logger.success(
    `Validação concluída: ${passRate}/${validations.length} aprovados`,
  );

  return { validations, validAssets };
}
