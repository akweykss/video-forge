// ============================================================
// @video-forge/integrations — Cliente AssemblyAI para transcrição
// ============================================================
import { AssemblyAI } from 'assemblyai';
import { getEnvOrThrow } from '../config';

/**
 * Resultado da transcrição de áudio.
 */
export interface TranscriptionResult {
  /** Texto completo transcrito */
  text: string;
  /** Palavras individuais com timestamps e confiança */
  words: Array<{
    text: string;
    /** Timestamp de início em milissegundos */
    start: number;
    /** Timestamp de fim em milissegundos */
    end: number;
    /** Nível de confiança (0 a 1) */
    confidence: number;
  }>;
  /** Duração total do áudio em milissegundos */
  durationMs: number;
}

/** Instância singleton do cliente AssemblyAI */
let clientInstance: AssemblyAI | null = null;

/**
 * Retorna a instância do cliente AssemblyAI (singleton).
 * @returns Instância configurada do AssemblyAI
 */
function getClient(): AssemblyAI {
  if (!clientInstance) {
    clientInstance = new AssemblyAI({
      apiKey: getEnvOrThrow('ASSEMBLYAI_API_KEY'),
    });
  }
  return clientInstance;
}

/**
 * Transcreve um arquivo de áudio usando a API AssemblyAI.
 *
 * O SDK cuida automaticamente do upload do arquivo para o AssemblyAI.
 * A transcrição é feita em Português (pt).
 *
 * @param audioPath - Caminho absoluto ou URL do arquivo de áudio
 * @returns Resultado da transcrição com texto, palavras e duração
 * @throws Error se a transcrição falhar ou retornar status de erro
 *
 * @example
 * ```ts
 * const resultado = await transcribeAudio('/caminho/para/audio.mp3');
 * console.log(resultado.text);
 * console.log(`Duração: ${resultado.durationMs}ms`);
 * ```
 */
export async function transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
  const client = getClient();

  try {
    console.log(`[AssemblyAI] Iniciando transcrição: ${audioPath}`);

    const transcript = await client.transcripts.transcribe({
      audio: audioPath,
      language_code: 'pt',
    });

    if (transcript.status === 'error') {
      throw new Error(
        `[AssemblyAI] Transcrição falhou: ${transcript.error ?? 'Erro desconhecido'}`
      );
    }

    if (!transcript.text) {
      throw new Error('[AssemblyAI] Transcrição retornou texto vazio.');
    }

    const words = (transcript.words ?? []).map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
    }));

    // Calcula duração: último timestamp de fim, ou usa audio_duration se disponível
    const durationMs =
      transcript.audio_duration != null
        ? transcript.audio_duration * 1000
        : words.length > 0
          ? words[words.length - 1].end
          : 0;

    console.log(
      `[AssemblyAI] Transcrição concluída: ${words.length} palavras, ` +
      `${Math.round(durationMs / 1000)}s de duração`
    );

    return {
      text: transcript.text,
      words,
      durationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[AssemblyAI] Falha na transcrição: ${message}`);
  }
}
