// ============================================================
// @video-forge/integrations — Cliente Claude (Anthropic)
// ============================================================
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { VideoManifestSchema, type VideoManifest } from '@video-forge/shared';
import { getEnvOrThrow } from '../config';
import {
  CONTENT_ANALYZER_SYSTEM_PROMPT,
  SCENE_PLANNER_SYSTEM_PROMPT,
  QUALITY_VALIDATOR_SYSTEM_PROMPT,
  type ImageValidation,
} from './prompts';

// ============================================================
// Tipos locais
// ============================================================

/**
 * Palavra individual com timestamp (compatível com AssemblyAI).
 */
export interface Word {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

/**
 * Tópico identificado na análise de conteúdo.
 */
export interface Topic {
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  relevance: string;
}

/**
 * Momento-chave identificado na análise.
 */
export interface KeyMoment {
  text: string;
  startMs: number;
  endMs: number;
  type: 'headline' | 'emphasis' | 'emotional_peak';
  suggestedVisual: string;
}

/**
 * Estatística identificada no conteúdo.
 */
export interface Statistic {
  value: string;
  context: string;
  startMs: number;
}

/**
 * Citação de destaque.
 */
export interface Quote {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Resultado completo da análise de conteúdo.
 */
export interface ContentAnalysis {
  topics: Topic[];
  keyMoments: KeyMoment[];
  statistics: Statistic[];
  quotes: Quote[];
  emotionalTone: {
    overall: string;
    variations: Array<{ tone: string; startMs: number; endMs: number }>;
    suggestedMood: string;
  };
  targetAudience: {
    description: string;
    ageRange: string;
    profile: string;
  };
  summary: string;
  totalDurationMs: number;
}

// ============================================================
// Schema Zod para validação da análise de conteúdo
// ============================================================
const ContentAnalysisSchema = z.object({
  premise: z.object({
    mainSubject: z.string(),
    category: z.string(),
    relatedEntities: z.array(z.string()).optional().default([]),
    mainArgument: z.string(),
    searchContext: z.string(),
  }).optional(),
  topics: z.array(z.object({
    title: z.string(),
    description: z.string(),
    startMs: z.number(),
    endMs: z.number(),
    relevance: z.string(),
  })),
  keyMoments: z.array(z.object({
    text: z.string(),
    startMs: z.number(),
    endMs: z.number(),
    type: z.enum(['headline', 'emphasis', 'emotional_peak']),
    suggestedVisual: z.string(),
  })),
  statistics: z.array(z.object({
    value: z.string(),
    context: z.string(),
    startMs: z.number(),
  })),
  quotes: z.array(z.object({
    text: z.string(),
    startMs: z.number(),
    endMs: z.number(),
  })),
  emotionalTone: z.object({
    overall: z.string(),
    variations: z.array(z.object({
      tone: z.string(),
      startMs: z.number(),
      endMs: z.number(),
    })),
    suggestedMood: z.string(),
  }),
  targetAudience: z.object({
    description: z.string(),
    ageRange: z.string(),
    profile: z.string(),
  }),
  summary: z.string(),
  totalDurationMs: z.number(),
});

// Schema para validação de qualidade de imagem
const ImageValidationSchema = z.object({
  scores: z.object({
    technical: z.number().min(1).max(5),
    relevance: z.number().min(1).max(5),
    artifacts: z.number().min(1).max(5),
    composition: z.number().min(1).max(5),
    watermark: z.number().min(1).max(5).optional().default(5),
  }),
  averageScore: z.number(),
  pass: z.boolean(),
  hasWatermark: z.boolean().optional().default(false),
  recommendation: z.enum(['approve', 'regenerate', 'try_stock']),
  issues: z.array(z.string()),
  suggestion: z.string(),
});

// ============================================================
// Cliente
// ============================================================

/** Modelo padrão do Claude para análise */
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

/** Instância singleton do cliente Anthropic */
let clientInstance: Anthropic | null = null;

/**
 * Retorna a instância do cliente Anthropic (singleton).
 * @returns Instância configurada do Anthropic
 */
function getClient(): Anthropic {
  if (!clientInstance) {
    clientInstance = new Anthropic({
      apiKey: getEnvOrThrow('ANTHROPIC_API_KEY'),
    });
  }
  return clientInstance;
}

/**
 * Extrai JSON de uma resposta do Claude, removendo markdown se necessário.
 * Inclui múltiplas estratégias de fallback para lidar com JSON malformado.
 * @param text - Texto da resposta do Claude
 * @returns JSON parseado
 */
function extractJson(text: string): unknown {
  // Strategy 1: Extract from markdown code block
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  let cleanText = jsonMatch ? jsonMatch[1].trim() : text.trim();

  // Strategy 2: If no code block, find first { to last }
  if (!jsonMatch) {
    const firstBrace = cleanText.indexOf('{');
    const lastBrace = cleanText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleanText = cleanText.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    return JSON.parse(cleanText);
  } catch (e1) {
    // Strategy 3: Remove trailing commas (common Claude mistake)
    const noTrailingCommas = cleanText
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']');
    try {
      return JSON.parse(noTrailingCommas);
    } catch (e2) {
      // Strategy 4: Remove JS-style comments
      const noComments = noTrailingCommas
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      try {
        return JSON.parse(noComments);
      } catch (e3) {
        // Final: throw with context
        const errorMsg = e1 instanceof Error ? e1.message : String(e1);
        console.error(`[Claude] JSON parse failed. First 500 chars:\n${cleanText.slice(0, 500)}`);
        throw new Error(`${errorMsg}`);
      }
    }
  }
}

/**
 * Analisa uma transcrição e extrai informações estruturadas para planejamento de vídeo.
 *
 * Utiliza o Claude para identificar tópicos, momentos-chave, estatísticas,
 * citações, tom emocional e público-alvo.
 *
 * @param transcript - Texto completo da transcrição
 * @param words - Array de palavras com timestamps
 * @returns Análise estruturada do conteúdo
 * @throws Error se a análise falhar ou o JSON for inválido
 *
 * @example
 * ```ts
 * const analise = await analyzeContent(
 *   'O INSS pagou R$ 800 bilhões em benefícios...',
 *   [{ text: 'O', start: 0, end: 200, confidence: 0.99 }]
 * );
 * console.log(analise.emotionalTone.suggestedMood);
 * ```
 */
export async function analyzeContent(
  transcript: string,
  words: Word[],
): Promise<ContentAnalysis> {
  const client = getClient();

  try {
    console.log('[Claude] Iniciando análise de conteúdo...');

    // Monta contexto com palavras e timestamps
    const wordsContext = words
      .map((w) => `[${w.start}-${w.end}] ${w.text}`)
      .join(' ');

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: CONTENT_ANALYZER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Analise a seguinte transcrição e extraia as informações estruturadas conforme solicitado.

## Transcrição Completa
${transcript}

## Palavras com Timestamps (formato: [início_ms-fim_ms] palavra)
${wordsContext}

Retorne o JSON de análise.`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude não retornou conteúdo de texto.');
    }

    const parsed = extractJson(textBlock.text);
    const validated = ContentAnalysisSchema.parse(parsed);

    console.log(
      `[Claude] Análise concluída: ${validated.topics.length} tópicos, ` +
      `${validated.keyMoments.length} momentos-chave, ` +
      `mood: ${validated.emotionalTone.suggestedMood}`
    );
    if (validated.premise) {
      console.log(
        `[Claude] 🎯 Premissa: "${validated.premise.mainSubject}" [${validated.premise.category}]`
      );
      console.log(
        `[Claude] 🔍 Contexto de busca: "${validated.premise.searchContext}"`
      );
    }

    return validated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Claude] Falha na análise de conteúdo: ${message}`);
  }
}

/**
 * Gera um VideoManifest completo a partir da análise de conteúdo.
 *
 * Transforma a análise em um plano de cenas detalhado, com tipos de visual,
 * animações, transições e sincronização com o áudio.
 *
 * @param analysis - Análise de conteúdo gerada por analyzeContent()
 * @param audioDurationSeconds - Duração total do áudio em segundos
 * @returns VideoManifest validado pelo schema Zod
 * @throws Error se o planejamento falhar ou o JSON não seguir o schema
 *
 * @example
 * ```ts
 * const manifest = await planScenes(analise, 45);
 * console.log(`${manifest.scenes.length} cenas planejadas`);
 * ```
 */
export async function planScenes(
  analysis: ContentAnalysis,
  audioDurationSeconds: number,
  words?: Array<{ text: string; start: number; end: number }>,
): Promise<VideoManifest> {
  const client = getClient();

  try {
    console.log(
      `[Claude] Planejando cenas para ${audioDurationSeconds}s de áudio...`
    );

    // Format word timestamps for Claude (e.g., "[0-500] Você [500-1200] vai ...")
    let wordTimeline = '';
    if (words && words.length > 0) {
      wordTimeline = '\n## Transcrição com Timestamps (ms)\n';
      wordTimeline += words
        .map((w) => `[${w.start}-${w.end}] ${w.text}`)
        .join(' ');
      wordTimeline += '\n\n⚠️ USE ESSES TIMESTAMPS EXATOS para definir narrationStartMs e narrationEndMs de cada cena. Cada cena DEVE ter timestamps que correspondem EXATAMENTE às palavras acima.';
    }

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      system: SCENE_PLANNER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Crie um VideoManifest completo para um vídeo de ${audioDurationSeconds} segundos baseado na seguinte análise de conteúdo:
${analysis.premise ? `
## ⚡ PREMISSA DO CONTEÚDO (LEIA PRIMEIRO!)
- ASSUNTO CENTRAL: ${analysis.premise.mainSubject}
- CATEGORIA: ${analysis.premise.category}
- ARGUMENTO PRINCIPAL: ${analysis.premise.mainArgument}
- CONTEXTO PARA BUSCAS: ${analysis.premise.searchContext}
${analysis.premise.relatedEntities && analysis.premise.relatedEntities.length > 0 ? `- ENTIDADES RELACIONADAS: ${analysis.premise.relatedEntities.join(', ')}` : ''}

⚠️ TODAS as stockQueries e imagePrompts DEVEM ser relacionadas a "${analysis.premise.mainSubject}".
${['movie', 'series'].includes(analysis.premise.category) ? `⚠️ Este vídeo é sobre um FILME/SÉRIE. Use visualType "stock_image" para buscar imagens REAIS da produção via TMDB. NÃO use ai_image para cenas de filmes/séries reais.
Inclua "${analysis.premise.mainSubject}" nas stockQueries para que o TMDB encontre as imagens corretas.` : ''}
` : ''}
## Análise de Conteúdo
${JSON.stringify(analysis, null, 2)}
${wordTimeline}

## Requisitos
- Duração total do áudio: ${audioDurationSeconds} segundos
- A soma das durações das cenas deve ser EXATAMENTE ${audioDurationSeconds}s
- Número estimado de cenas: ${Math.max(3, Math.min(20, Math.ceil(audioDurationSeconds / 3)))}
- Cada cena DEVE ter narrationStartMs e narrationEndMs baseados nos timestamps das palavras
- narrationText deve ser o trecho EXATO da transcrição para essa cena
- Mood sugerido: ${analysis.emotionalTone.suggestedMood}
- Idioma: pt-BR

Gere o VideoManifest JSON completo.`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude não retornou conteúdo de texto.');
    }

    const parsed = extractJson(textBlock.text);
    const validated = VideoManifestSchema.parse(parsed);

    console.log(
      `[Claude] Planejamento concluído: ${validated.scenes.length} cenas, ` +
      `mood: ${validated.style.mood}`
    );

    return validated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Claude] Falha no planejamento de cenas: ${message}`);
  }
}

/**
 * Valida a qualidade de uma imagem gerada usando a visão do Claude.
 *
 * Analisa a imagem em 4 critérios (técnica, relevância, artefatos, composição)
 * e retorna aprovação/reprovação com base na média das notas.
 *
 * @param imageUrl - URL ou caminho base64 da imagem a ser validada
 * @param expectedDescription - Descrição do que a imagem deveria representar
 * @returns Resultado da validação com scores e recomendação
 * @throws Error se a validação falhar
 *
 * @example
 * ```ts
 * const validacao = await validateImage(
 *   'https://exemplo.com/imagem.png',
 *   'Pessoa idosa sorrindo em ambiente corporativo'
 * );
 * if (validacao.pass) console.log('Imagem aprovada!');
 * ```
 */
export async function validateImage(
  imageUrl: string,
  expectedDescription: string,
): Promise<ImageValidation> {
  const client = getClient();

  try {
    console.log('[Claude] Validando qualidade da imagem...');

    // Determina o tipo de source para a imagem
    let imageContent: Anthropic.ImageBlockParam;

    if (imageUrl.startsWith('data:')) {
      // Already base64
      imageContent = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageUrl.replace(/^data:image\/\w+;base64,/, ''),
        },
      };
    } else if (imageUrl.startsWith('/') || imageUrl.match(/^[A-Z]:/)) {
      // Local file path — read and convert to base64
      const fs = await import('fs');
      if (!fs.existsSync(imageUrl)) {
        throw new Error(`Image file not found: ${imageUrl}`);
      }
      const fileBuffer = fs.readFileSync(imageUrl);
      const base64Data = fileBuffer.toString('base64');
      const ext = imageUrl.split('.').pop()?.toLowerCase() || 'png';
      const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
        : 'image/png';
      imageContent = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
          data: base64Data,
        },
      };
    } else {
      // Remote URL
      imageContent = {
        type: 'image',
        source: {
          type: 'url',
          url: imageUrl,
        },
      };
    }

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: QUALITY_VALIDATOR_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            imageContent,
            {
              type: 'text',
              text: `Avalie a qualidade desta imagem. Ela deveria representar: "${expectedDescription}"\n\nRetorne o JSON de avaliação.`,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude não retornou conteúdo de texto.');
    }

    const parsed = extractJson(textBlock.text);
    const validated = ImageValidationSchema.parse(parsed);

    console.log(
      `[Claude] Validação concluída: média ${validated.averageScore.toFixed(1)}, ` +
      `${validated.pass ? 'APROVADA ✅' : 'REPROVADA ❌'} — ${validated.recommendation}` +
      `${validated.hasWatermark ? ' ⚠️ MARCA D\'ÁGUA DETECTADA' : ''}`
    );

    return validated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Claude] Falha na validação de imagem: ${message}`);
  }
}

// Re-exporta os prompts para uso externo
export {
  CONTENT_ANALYZER_SYSTEM_PROMPT,
  SCENE_PLANNER_SYSTEM_PROMPT,
  IMAGE_PROMPTER_SYSTEM_PROMPT,
  QUALITY_VALIDATOR_SYSTEM_PROMPT,
} from './prompts';
export { IMAGE_PROMPTER_SYSTEM_PROMPT as IMAGE_PROMPT_SYSTEM } from './prompts/image-prompter';
