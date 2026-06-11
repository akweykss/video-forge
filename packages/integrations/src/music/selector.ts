// ============================================================
// @video-forge/integrations — Seletor de Música
// ============================================================
import { searchMusic, downloadPixabayAsset, type MusicTrack } from '../stock/pixabay';
import type { VideoMood } from '@video-forge/shared';

/**
 * Mapeamento de moods do VideoForge para categorias/queries
 * de busca na API Pixabay Music.
 *
 * Cada mood mapeia para uma query de busca e uma categoria opcional,
 * otimizadas para encontrar músicas adequadas ao tom do vídeo.
 */
const MOOD_TO_MUSIC_MAP: Record<VideoMood, { query: string; category?: string }> = {
  energetico: {
    query: 'upbeat energetic',
    category: 'beats',
  },
  motivacional: {
    query: 'motivational inspiring',
    category: 'cinematic',
  },
  calmo: {
    query: 'calm peaceful ambient',
    category: 'ambient',
  },
  profissional: {
    query: 'corporate professional',
    category: 'corporate',
  },
  dramatico: {
    query: 'dramatic tension cinematic',
    category: 'cinematic',
  },
  informativo: {
    query: 'light background neutral',
    category: 'corporate',
  },
  inspirador: {
    query: 'inspirational uplifting',
    category: 'cinematic',
  },
  urgente: {
    query: 'fast paced urgent intense',
    category: 'beats',
  },
};

/**
 * Seleciona uma música royalty-free adequada ao mood do vídeo.
 *
 * Usa a API Pixabay Music para buscar faixas que correspondam
 * ao tom emocional do vídeo. Baixa automaticamente para o
 * diretório `assets/downloaded/music/`.
 *
 * @param mood - Tom emocional do vídeo (conforme VideoMood do schema)
 * @returns Faixa musical com caminho local do arquivo baixado
 * @throws Error se nenhuma música for encontrada para o mood
 *
 * @example
 * ```ts
 * const musica = await selectMusic('motivacional');
 * console.log(`Música: ${musica.title}`);
 * console.log(`Arquivo: ${musica.localPath}`);
 * ```
 */
export async function selectMusic(mood: string): Promise<MusicTrack> {
  const moodKey = mood as VideoMood;
  const mapping = MOOD_TO_MUSIC_MAP[moodKey];

  if (!mapping) {
    console.warn(
      `[Music] Mood "${mood}" não reconhecido, usando busca genérica.`
    );
  }

  const { query, category } = mapping ?? { query: 'background music' };

  try {
    console.log(`[Music] Buscando música para mood "${mood}": query="${query}"`);

    const tracks = await searchMusic(query, category, 5);

    if (tracks.length === 0) {
      // Fallback: busca genérica sem categoria
      console.warn(
        `[Music] Nenhuma música encontrada com categoria. Tentando busca genérica...`
      );
      const fallbackTracks = await searchMusic(query, undefined, 5);
      if (fallbackTracks.length === 0) {
        throw new Error(`Nenhuma música encontrada para mood "${mood}".`);
      }
      tracks.push(...fallbackTracks);
    }

    // Seleciona a primeira faixa (melhor correspondência)
    const selectedTrack = tracks[0];

    // Baixa a música para o diretório local
    const localPath = await downloadPixabayAsset(
      selectedTrack.downloadUrl,
      'music',
      `${mood}-${selectedTrack.id}.mp3`
    );

    console.log(
      `[Music] Música selecionada: "${selectedTrack.title}" ` +
      `(${selectedTrack.duration}s, mood: ${mood})`
    );

    return {
      ...selectedTrack,
      localPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Music] Falha na seleção de música: ${message}`);
  }
}
