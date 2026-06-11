import { z } from 'zod';

// ============================================================
// TIPOS DE ANIMAÇÃO — Efeitos visuais disponíveis no Remotion
// ============================================================
// Valores esperados: fade-in, slide-left, slide-right, slide-up,
// zoom-in, zoom-out, ken-burns, bounce, kinetic-text, parallax,
// typewriter, scale-up
// Relaxado para z.string() pois Claude pode retornar variações
export const AnimationType = z.string().default('fade-in');
export type AnimationType = string;

// ============================================================
// TIPOS DE TRANSIÇÃO — Transições entre cenas
// ============================================================
// Valores esperados: fade, cut, slide, wipe, dissolve
export const TransitionType = z.string().default('fade');
export type TransitionType = string;

// ============================================================
// TIPO DE VISUAL — Fonte do asset visual
// ============================================================
// Valores esperados: ai_image, stock_video, stock_image, text_card, animation_only
export const VisualType = z.string().default('text_card');
export type VisualType = string;

// ============================================================
// TIPO DE CENA — Propósito narrativo da cena
// ============================================================
// Valores esperados: hero, content, quote, broll, statistic, cta, transition_card
export const SceneType = z.string().default('content');
export type SceneType = string;

// ============================================================
// MOOD — Tom emocional do vídeo (para seleção de música)
// ============================================================
// Valores esperados: energetico, motivacional, calmo, profissional,
// dramatico, informativo, inspirador, urgente
export const VideoMood = z.string().default('informativo');
export type VideoMood = string;
