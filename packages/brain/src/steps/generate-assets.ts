/**
 * Etapa 4: Geração de Assets
 * Gera/busca todos os assets visuais em paralelo
 * - Imagens IA via Nano Banana Pro (Google AI Studio)
 * - B-rolls via Pexels API
 * - Fotos stock via Pixabay API
 */

import {
  generateImage,
  findBRoll,
  findImage,
  downloadAsset,
} from '@video-forge/integrations';
import type { VideoManifest, Scene } from '@video-forge/shared';
import { PipelineLogger } from '../utils/logger';

export interface GeneratedAsset {
  sceneId: string;
  localPath: string;
  type: 'image' | 'video';
  source: 'ai' | 'stock';
}

export interface GenerateAssetsStepResult {
  assets: GeneratedAsset[];
}

/**
 * Gera um asset para uma cena individual
 */
async function generateAssetForScene(
  scene: Scene,
  logger: PipelineLogger,
): Promise<GeneratedAsset | null> {
  try {
    switch (scene.visualType) {
      case 'ai_image': {
        if (!scene.imagePrompt) {
          logger.warn(`Cena ${scene.id}: sem imagePrompt, pulando geração IA`);
          return null;
        }
        logger.info(`Cena ${scene.id}: Gerando imagem IA - "${scene.imagePrompt.substring(0, 50)}..."`);
        const result = await generateImage(scene.imagePrompt, '9:16');
        return {
          sceneId: scene.id,
          localPath: result.localPath,
          type: 'image',
          source: 'ai',
        };
      }

      case 'stock_video': {
        if (!scene.stockQuery) {
          logger.warn(`Cena ${scene.id}: sem stockQuery, pulando busca de vídeo`);
          return null;
        }
        logger.info(`Cena ${scene.id}: Buscando B-roll - "${scene.stockQuery}"`);
        const video = await findBRoll(scene.stockQuery);
        if (!video) {
          logger.warn(`Cena ${scene.id}: Nenhum B-roll encontrado para "${scene.stockQuery}"`);
          return null;
        }
        const localPath = await downloadAsset(video.url, 'videos');
        return {
          sceneId: scene.id,
          localPath,
          type: 'video',
          source: 'stock',
        };
      }

      case 'stock_image': {
        if (!scene.stockQuery) {
          logger.warn(`Cena ${scene.id}: sem stockQuery, pulando busca de imagem`);
          return null;
        }
        logger.info(`Cena ${scene.id}: Buscando foto stock - "${scene.stockQuery}"`);
        const photo = await findImage(scene.stockQuery);
        if (!photo) {
          logger.warn(`Cena ${scene.id}: Nenhuma foto encontrada para "${scene.stockQuery}"`);
          return null;
        }
        const localPath = await downloadAsset(photo.url, 'images');
        return {
          sceneId: scene.id,
          localPath,
          type: 'image',
          source: 'stock',
        };
      }

      case 'text_card':
      case 'animation_only':
        // Não precisa de asset externo
        return null;

      default:
        logger.warn(`Cena ${scene.id}: visualType desconhecido "${scene.visualType}"`);
        return null;
    }
  } catch (error) {
    logger.error(`Cena ${scene.id}: Falha ao gerar asset`, error);
    return null;
  }
}

/**
 * Executa a geração de assets para todas as cenas em paralelo
 */
export async function executeGenerateAssets(
  manifest: VideoManifest,
  logger: PipelineLogger,
): Promise<GenerateAssetsStepResult> {
  logger.info(`Gerando assets para ${manifest.scenes.length} cenas...`);

  // Executa em paralelo com concorrência limitada (3 por vez)
  const CONCURRENCY = 3;
  const assets: GeneratedAsset[] = [];
  const scenes = manifest.scenes.filter(
    (s) => s.visualType !== 'text_card' && s.visualType !== 'animation_only',
  );

  for (let i = 0; i < scenes.length; i += CONCURRENCY) {
    const batch = scenes.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((scene) => generateAssetForScene(scene, logger)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        assets.push(result.value);
      }
    }
  }

  logger.success(
    `Assets gerados: ${assets.length}/${scenes.length} (${assets.filter((a) => a.source === 'ai').length} IA, ${assets.filter((a) => a.source === 'stock').length} stock)`,
  );

  return { assets };
}
