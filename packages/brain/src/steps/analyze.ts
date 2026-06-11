/**
 * Etapa 2: Análise de Conteúdo
 * Usa Claude para analisar a transcrição e extrair informações estruturadas
 */

import { analyzeContent, type ContentAnalysis } from '@video-forge/integrations';
import { PipelineLogger } from '../utils/logger';
import type { TranscribeStepResult } from './transcribe';

export interface AnalyzeStepResult {
  analysis: ContentAnalysis;
}

/**
 * Executa a análise de conteúdo da transcrição
 * @param transcription - Resultado da etapa de transcrição
 * @param logger - Logger do pipeline
 */
export async function executeAnalyze(
  transcription: TranscribeStepResult,
  logger: PipelineLogger,
): Promise<AnalyzeStepResult> {
  logger.info('Analisando conteúdo com Claude...');

  const analysis = await analyzeContent(transcription.text, transcription.words);

  logger.success(
    `Análise concluída: ${analysis.mainTopics.length} tópicos, mood: ${analysis.mood}`,
  );
  logger.info(`Tópicos: ${analysis.mainTopics.join(', ')}`);

  return { analysis };
}
