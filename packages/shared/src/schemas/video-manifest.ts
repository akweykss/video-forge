import { z } from 'zod';
import {
  AnimationType,
  TransitionType,
  VisualType,
  SceneType,
  VideoMood,
} from './scene-types';

// ============================================================
// SCHEMA DE CENA — Uma cena individual do vídeo
// ============================================================
export const SceneSchema = z.object({
  /** Identificador único da cena */
  id: z.string(),

  /** Tipo narrativo da cena */
  type: SceneType,

  /** Duração em segundos (será convertido para frames) */
  durationInSeconds: z.number().min(2).max(15),

  // --- Conteúdo Textual ---
  /** Título/headline principal da cena */
  headline: z.string().nullish(),

  /** Texto do corpo / informação principal */
  body: z.string().nullish(),

  /** Subtítulo ou texto secundário */
  subtitle: z.string().nullish(),

  // --- Visual ---
  /** Tipo do asset visual principal */
  visualType: VisualType,

  /** Prompt para Nano Banana Pro gerar imagem (quando visualType === 'ai_image') */
  imagePrompt: z.string().nullish(),

  /** Query de busca para Pexels/Pixabay (quando visualType === 'stock_video' ou 'stock_image') */
  stockQuery: z.string().nullish(),

  /** URL do asset visual resolvido (preenchido pelo pipeline) */
  assetUrl: z.string().nullish(),

  // --- Animações ---
  /** Tipo de animação de entrada */
  animation: AnimationType,

  /** Tipo de transição para a próxima cena */
  transition: TransitionType.default('fade'),

  /** Duração da transição em frames (padrão: 15 frames = 0.5s) */
  transitionDurationFrames: z.number().default(15),

  // --- Áudio / Sincronização ---
  /** Texto que está sendo narrado nesta cena */
  narrationText: z.string().nullish(),

  /** Timestamp de início no áudio original (ms) */
  narrationStartMs: z.number().nullish(),

  /** Timestamp de fim no áudio original (ms) */
  narrationEndMs: z.number().nullish(),
});

export type Scene = z.infer<typeof SceneSchema>;

// ============================================================
// SCHEMA DO VIDEO MANIFEST — O contrato entre Claude e Remotion
// ============================================================
export const VideoManifestSchema = z.object({
  /** Metadados do vídeo */
  meta: z.object({
    /** Título do vídeo */
    title: z.string(),
    /** Descrição curta */
    description: z.string(),
    /** Idioma (sempre PT-BR) */
    language: z.string().default('pt-BR'),
    /** Frames por segundo */
    fps: z.number().default(30),
    /** Largura em pixels (9:16 vertical) */
    width: z.number().default(1080),
    /** Altura em pixels (9:16 vertical) */
    height: z.number().default(1920),
  }),

  /** Estilo visual global */
  style: z.object({
    /** Cor primária (hex) */
    primaryColor: z.string(),
    /** Cor secundária (hex) */
    secondaryColor: z.string(),
    /** Cor de fundo padrão (hex) */
    backgroundColor: z.string(),
    /** Fonte principal */
    fontFamily: z.string().default('Inter'),
    /** Tom/mood do vídeo */
    mood: VideoMood,
  }),

  /** Lista de cenas (mínimo 3, máximo 20) */
  scenes: z.array(SceneSchema).min(3).max(60),

  /** URL do arquivo de áudio original (narração) */
  audioUrl: z.string().nullish(),

  /** URL da música de fundo */
  backgroundMusicUrl: z.string().nullish(),

  /** Volume da música de fundo (0-1, padrão 0.15) */
  backgroundMusicVolume: z.number().min(0).max(1).default(0.15),
});

export type VideoManifest = z.infer<typeof VideoManifestSchema>;

// ============================================================
// SCHEMA DE CENA RESOLVIDA — Após assets serem gerados/baixados
// ============================================================
export const ResolvedSceneSchema = SceneSchema.extend({
  /** URL local do asset visual (preenchido após download/geração) */
  assetUrl: z.string().default(''),
  /** Duração em frames (calculado a partir de durationInSeconds * fps) */
  durationInFrames: z.number(),
  /** Frame absoluto de início (baseado no timestamp da narração) */
  startFrame: z.number().default(0),
});

export type ResolvedScene = z.infer<typeof ResolvedSceneSchema>;

/** Manifest com todas as cenas resolvidas (pronto para renderização) */
export const ResolvedVideoManifestSchema = VideoManifestSchema.extend({
  scenes: z.array(ResolvedSceneSchema).min(3).max(60),
  /** Duração total em frames */
  totalDurationInFrames: z.number(),
  /** Caminho local do áudio */
  localAudioPath: z.string().nullish(),
  /** Caminho local da música de fundo */
  localMusicPath: z.string().nullish(),
  /** Word-level timestamps for synchronized captions */
  words: z.array(z.object({
    text: z.string(),
    start: z.number(), // ms
    end: z.number(),   // ms
  })).optional(),
});

export type ResolvedVideoManifest = z.infer<typeof ResolvedVideoManifestSchema>;
