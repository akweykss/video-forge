/**
 * 🧠 Pipeline de Áudio → Vídeo
 * Pipeline principal que orquestra todas as 7 etapas
 * de forma sequencial para gerar um vídeo a partir de áudio
 */

import * as path from 'path';
import * as fs from 'fs';
import { PipelineLogger, createProgressTracker, updateProgress } from '../utils/logger';
import { executeTranscribe } from '../steps/transcribe';
import { executeAnalyze } from '../steps/analyze';
import { executePlanScenes } from '../steps/plan-scenes';
import { executeGenerateAssets } from '../steps/generate-assets';
import { executeValidateAssets } from '../steps/validate-assets';
import { executeSyncTiming } from '../steps/sync-timing';
import { executeRender } from '../steps/render';

const TOTAL_STEPS = 7;

export interface GenerateOptions {
  /** Diretório de saída para o vídeo final */
  outputDir?: string;
  /** Pular validação visual (mais rápido, mais barato) */
  skipValidation?: boolean;
  /** Pular renderização (útil para testar o pipeline sem Remotion) */
  skipRender?: boolean;
}

/**
 * Gera um vídeo a partir de um arquivo de áudio
 *
 * Pipeline completo:
 * 1. Transcrição (AssemblyAI)
 * 2. Análise de conteúdo (Claude)
 * 3. Planejamento de cenas (Claude → VideoManifest)
 * 4. Geração de assets (Nano Banana Pro + Pexels + Pixabay)
 * 5. Validação visual (Claude Vision)
 * 6. Sincronização de timing
 * 7. Renderização (Remotion)
 *
 * @param audioPath - Caminho do arquivo de áudio (mp3/wav/m4a)
 * @param options - Opções de geração
 * @returns Caminho do vídeo MP4 gerado
 */
export async function generateVideoFromAudio(
  audioPath: string,
  options: GenerateOptions = {},
): Promise<string> {
  const startTime = Date.now();

  // Valida input
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Arquivo de áudio não encontrado: ${audioPath}`);
  }

  // Setup
  const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const outputDir = options.outputDir || path.join(projectRoot, 'assets', 'output');
  const tracker = createProgressTracker(audioPath);
  const logger = new PipelineLogger(tracker.jobId);

  console.log('\n' + '═'.repeat(60));
  console.log('🧠 VideoForge — Gerador Automático de Vídeos');
  console.log('═'.repeat(60));
  console.log(`📁 Input: ${audioPath}`);
  console.log(`📁 Output: ${outputDir}`);
  console.log(`🆔 Job: ${tracker.jobId}`);
  console.log('═'.repeat(60) + '\n');

  try {
    // ============================================================
    // ETAPA 1: Transcrição
    // ============================================================
    updateProgress(tracker, 'transcribing', 10, 'Transcrevendo áudio');
    logger.step(1, TOTAL_STEPS, 'Transcrição do Áudio (AssemblyAI)');
    const transcription = await executeTranscribe(audioPath, logger);

    // ============================================================
    // ETAPA 2: Análise de Conteúdo
    // ============================================================
    updateProgress(tracker, 'analyzing', 25, 'Analisando conteúdo');
    logger.step(2, TOTAL_STEPS, 'Análise de Conteúdo (Claude)');
    const { analysis } = await executeAnalyze(transcription, logger);

    // ============================================================
    // ETAPA 3: Planejamento de Cenas
    // ============================================================
    updateProgress(tracker, 'planning', 35, 'Planejando cenas');
    logger.step(3, TOTAL_STEPS, 'Planejamento de Cenas (Claude → VideoManifest)');
    const { manifest } = await executePlanScenes(
      analysis,
      transcription.durationSeconds,
      logger,
    );

    // ============================================================
    // ETAPA 4: Geração de Assets
    // ============================================================
    updateProgress(tracker, 'generating_assets', 50, 'Gerando assets visuais');
    logger.step(4, TOTAL_STEPS, 'Geração de Assets (Nano Banana Pro + Pexels + Pixabay)');
    const { assets } = await executeGenerateAssets(manifest, logger);

    // ============================================================
    // ETAPA 5: Validação Visual
    // ============================================================
    let validAssets = assets;
    if (!options.skipValidation) {
      updateProgress(tracker, 'validating_assets', 65, 'Validando qualidade visual');
      logger.step(5, TOTAL_STEPS, 'Validação Visual (Claude Vision)');
      const validation = await executeValidateAssets(manifest, assets, logger);
      validAssets = validation.validAssets;
    } else {
      logger.info('Validação visual pulada (skipValidation=true)');
    }

    // ============================================================
    // ETAPA 6: Sincronização de Timing
    // ============================================================
    updateProgress(tracker, 'syncing', 80, 'Sincronizando timing');
    logger.step(6, TOTAL_STEPS, 'Sincronização de Timing');
    const { resolvedManifest } = await executeSyncTiming(
      manifest,
      transcription,
      validAssets,
      audioPath,
      logger,
    );

    // ============================================================
    // ETAPA 7: Renderização
    // ============================================================
    if (!options.skipRender) {
      updateProgress(tracker, 'rendering', 90, 'Renderizando vídeo');
      logger.step(7, TOTAL_STEPS, 'Renderização (Remotion)');
      const { outputPath, durationMs: renderTime } = await executeRender(
        resolvedManifest,
        outputDir,
        logger,
      );

      updateProgress(tracker, 'completed', 100, 'Concluído');
      const totalTime = Date.now() - startTime;
      logger.done(outputPath, totalTime);

      return outputPath;
    } else {
      // Salva apenas o manifest (útil para debug)
      const manifestPath = path.join(outputDir, `manifest-${tracker.jobId.slice(0, 8)}.json`);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify(resolvedManifest, null, 2), 'utf-8');

      updateProgress(tracker, 'completed', 100, 'Concluído (sem render)');
      logger.success(`Renderização pulada. Manifest salvo em: ${manifestPath}`);

      const totalTime = Date.now() - startTime;
      logger.done(manifestPath, totalTime);

      return manifestPath;
    }
  } catch (error) {
    updateProgress(tracker, 'failed', tracker.progress, `Erro: ${error}`);
    logger.error('Pipeline falhou', error);
    throw error;
  }
}
