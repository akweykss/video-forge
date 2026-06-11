import { z } from 'zod';

// ============================================================
// STATUS DO JOB — Estados possíveis de um job de geração
// ============================================================
export const JobStatus = z.enum([
  'idle',
  'transcribing',
  'analyzing',
  'planning',
  'generating_assets',
  'validating_assets',
  'syncing',
  'rendering',
  'completed',
  'failed',
]);
export type JobStatus = z.infer<typeof JobStatus>;

// ============================================================
// TIPO DE INPUT — Como o job foi iniciado
// ============================================================
export const InputType = z.enum([
  'audio',             // Modo 1: Áudio direto
  'script',            // Modo 2: Roteiro de texto
  'reference_video',   // Modo 3: Vídeo de referência
]);
export type InputType = z.infer<typeof InputType>;

// ============================================================
// SCHEMA DO JOB — Um job de geração de vídeo
// ============================================================
export const VideoJobSchema = z.object({
  /** ID único do job */
  id: z.string().uuid(),

  /** Tipo de input */
  inputType: InputType,

  /** Status atual */
  status: JobStatus.default('idle'),

  /** Progresso (0-100) */
  progress: z.number().min(0).max(100).default(0),

  /** Caminho/URL do input original */
  inputPath: z.string(),

  /** Transcrição gerada */
  transcript: z.string().optional(),

  /** Palavras com timestamps */
  words: z.array(z.object({
    text: z.string(),
    start: z.number(),
    end: z.number(),
    confidence: z.number(),
  })).optional(),

  /** Caminho do vídeo final */
  outputPath: z.string().optional(),

  /** Erro (se falhou) */
  error: z.string().optional(),

  /** Timestamps */
  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),

  /** Duração do áudio em segundos */
  audioDurationSeconds: z.number().optional(),
});

export type VideoJob = z.infer<typeof VideoJobSchema>;
