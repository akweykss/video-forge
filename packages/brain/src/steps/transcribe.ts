/**
 * Etapa 1: Transcrição de Áudio
 * Usa AssemblyAI para transcrever áudio em português (PT-BR)
 * Retorna texto + word-level timestamps
 */

import type { TranscriptionResult } from '@video-forge/integrations';
import { transcribeAudio } from '@video-forge/integrations';
import { PipelineLogger } from '../utils/logger';

export interface TranscribeStepResult {
  /** Texto completo da transcrição */
  text: string;
  /** Palavras com timestamps (ms) e confidence */
  words: Array<{
    text: string;
    start: number;
    end: number;
    confidence: number;
  }>;
  /** Duração total do áudio em ms */
  durationMs: number;
  /** Duração total em segundos */
  durationSeconds: number;
}

/**
 * Executa a transcrição do áudio
 * @param audioPath - Caminho local do arquivo de áudio
 * @param logger - Logger do pipeline
 */
export async function executeTranscribe(
  audioPath: string,
  logger: PipelineLogger,
): Promise<TranscribeStepResult> {
  logger.info(`Transcrevendo áudio: ${audioPath}`);

  const result: TranscriptionResult = await transcribeAudio(audioPath);

  const durationMs = result.durationMs;
  const durationSeconds = durationMs / 1000;

  logger.success(
    `Transcrição concluída: ${result.words.length} palavras, ${durationSeconds.toFixed(1)}s`,
  );
  logger.info(`Prévia: "${result.text.substring(0, 100)}..."`);

  return {
    text: result.text,
    words: result.words,
    durationMs,
    durationSeconds,
  };
}
