// ============================================================
// @video-forge/integrations — Cliente Pixabay (Stock + Música)
// ============================================================
import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { getEnvOrThrow, DOWNLOADED_ASSETS_DIR, MUSIC_ASSETS_DIR } from '../config';

const PIXABAY_BASE_URL = 'https://pixabay.com/api';

/**
 * Vídeo de stock retornado pela API Pixabay.
 */
export interface PixabayStockVideo {
  /** ID do vídeo no Pixabay */
  id: number;
  /** URL da página do vídeo */
  url: string;
  /** URL de download do vídeo */
  downloadUrl: string;
  /** Caminho local após download (se baixado) */
  localPath?: string;
  /** Largura em pixels */
  width: number;
  /** Altura em pixels */
  height: number;
  /** Duração em segundos */
  duration: number;
  /** Tags do vídeo */
  tags: string;
  /** Fonte: pixabay */
  source: 'pixabay';
}

/**
 * Foto de stock retornada pela API Pixabay.
 */
export interface PixabayStockPhoto {
  /** ID da foto no Pixabay */
  id: number;
  /** URL da página da foto */
  url: string;
  /** URL de download em alta resolução */
  downloadUrl: string;
  /** Caminho local após download (se baixado) */
  localPath?: string;
  /** Largura em pixels */
  width: number;
  /** Altura em pixels */
  height: number;
  /** Tags da foto */
  tags: string;
  /** Fonte: pixabay */
  source: 'pixabay';
}

/**
 * Faixa de música retornada pela API Pixabay Music.
 */
export interface MusicTrack {
  /** ID da faixa no Pixabay */
  id: number;
  /** Título da faixa */
  title: string;
  /** URL da página */
  url: string;
  /** URL de download do áudio */
  downloadUrl: string;
  /** Caminho local após download (se baixado) */
  localPath?: string;
  /** Duração em segundos */
  duration: number;
  /** Tags da faixa */
  tags: string;
  /** Fonte: pixabay */
  source: 'pixabay';
}

/**
 * Executa uma requisição para a API Pixabay.
 * @param endpoint - Caminho do endpoint
 * @param params - Parâmetros de query string
 * @returns Resposta JSON parseada
 */
async function pixabayFetch<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const apiKey = getEnvOrThrow('PIXABAY_API_KEY');
  const allParams = { key: apiKey, ...params };
  const queryString = new URLSearchParams(allParams).toString();
  const url = `${PIXABAY_BASE_URL}${endpoint}?${queryString}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `[Pixabay] Requisição falhou: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Busca vídeos no banco de vídeos Pixabay.
 *
 * @param query - Termo de busca
 * @param perPage - Número de resultados (padrão: 5)
 * @returns Array de vídeos encontrados
 * @throws Error se a busca falhar
 *
 * @example
 * ```ts
 * const videos = await searchVideos('finance business');
 * ```
 */
export async function searchVideos(
  query: string,
  perPage: number = 5,
): Promise<PixabayStockVideo[]> {
  try {
    console.log(`[Pixabay] Buscando vídeos: "${query}"`);

    interface PixabayVideoHit {
      id: number;
      pageURL: string;
      tags: string;
      duration: number;
      videos: {
        large: { url: string; width: number; height: number };
        medium: { url: string; width: number; height: number };
        small: { url: string; width: number; height: number };
      };
    }

    interface PixabayVideoResponse {
      hits: PixabayVideoHit[];
    }

    const data = await pixabayFetch<PixabayVideoResponse>('/videos/', {
      q: query,
      per_page: String(perPage),
      lang: 'pt',
    });

    const videos: PixabayStockVideo[] = (data.hits ?? []).map((hit) => {
      const bestVideo = hit.videos.large || hit.videos.medium || hit.videos.small;
      return {
        id: hit.id,
        url: hit.pageURL,
        downloadUrl: bestVideo.url,
        width: bestVideo.width,
        height: bestVideo.height,
        duration: hit.duration,
        tags: hit.tags,
        source: 'pixabay' as const,
      };
    });

    console.log(`[Pixabay] ${videos.length} vídeos encontrados para "${query}"`);
    return videos;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Pixabay] Falha na busca de vídeos: ${message}`);
  }
}

/**
 * Busca fotos no banco de imagens Pixabay.
 *
 * @param query - Termo de busca
 * @param perPage - Número de resultados (padrão: 5)
 * @returns Array de fotos encontradas
 * @throws Error se a busca falhar
 *
 * @example
 * ```ts
 * const fotos = await searchPhotos('retirement elderly');
 * ```
 */
export async function searchPhotos(
  query: string,
  perPage: number = 5,
): Promise<PixabayStockPhoto[]> {
  try {
    console.log(`[Pixabay] Buscando fotos: "${query}"`);

    interface PixabayPhotoHit {
      id: number;
      pageURL: string;
      tags: string;
      imageWidth: number;
      imageHeight: number;
      largeImageURL: string;
      fullHDURL?: string;
    }

    interface PixabayPhotoResponse {
      hits: PixabayPhotoHit[];
    }

    const data = await pixabayFetch<PixabayPhotoResponse>('/', {
      q: query,
      per_page: String(perPage),
      image_type: 'photo',
      orientation: 'vertical',
      lang: 'pt',
    });

    const photos: PixabayStockPhoto[] = (data.hits ?? []).map((hit) => ({
      id: hit.id,
      url: hit.pageURL,
      downloadUrl: hit.fullHDURL || hit.largeImageURL,
      width: hit.imageWidth,
      height: hit.imageHeight,
      tags: hit.tags,
      source: 'pixabay' as const,
    }));

    console.log(`[Pixabay] ${photos.length} fotos encontradas para "${query}"`);
    return photos;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Pixabay] Falha na busca de fotos: ${message}`);
  }
}

/**
 * Busca músicas royalty-free na API Pixabay Music.
 *
 * @param query - Termo de busca (ex: 'upbeat', 'calm piano')
 * @param category - Categoria opcional (ex: 'beats', 'ambient', 'cinematic')
 * @param perPage - Número de resultados (padrão: 5)
 * @returns Array de faixas musicais encontradas
 * @throws Error se a busca falhar
 *
 * @example
 * ```ts
 * const musicas = await searchMusic('motivational', 'cinematic');
 * ```
 */
export async function searchMusic(
  query: string,
  category?: string,
  perPage: number = 5,
): Promise<MusicTrack[]> {
  try {
    console.log(`[Pixabay] Buscando músicas: "${query}"${category ? ` (categoria: ${category})` : ''}`);

    interface PixabayMusicHit {
      id: number;
      title: string;
      url: string;
      audio: string;
      duration: number;
      tags: string;
    }

    interface PixabayMusicResponse {
      hits: PixabayMusicHit[];
    }

    // A API de música do Pixabay usa um endpoint separado
    const apiKey = getEnvOrThrow('PIXABAY_API_KEY');
    const params: Record<string, string> = {
      key: apiKey,
      q: query,
      per_page: String(perPage),
    };
    if (category) {
      params.category = category;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `https://pixabay.com/api/music/?${queryString}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Requisição falhou: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as PixabayMusicResponse;

    const tracks: MusicTrack[] = (data.hits ?? []).map((hit) => ({
      id: hit.id,
      title: hit.title,
      url: hit.url,
      downloadUrl: hit.audio,
      duration: hit.duration,
      tags: hit.tags,
      source: 'pixabay' as const,
    }));

    console.log(`[Pixabay] ${tracks.length} músicas encontradas para "${query}"`);
    return tracks;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Pixabay] Falha na busca de músicas: ${message}`);
  }
}

/**
 * Baixa um asset (vídeo, foto ou música) do Pixabay para o diretório local.
 *
 * @param downloadUrl - URL de download do asset
 * @param type - Tipo do asset ('video' | 'photo' | 'music')
 * @param filename - Nome do arquivo de destino (opcional, gera UUID)
 * @returns Caminho absoluto do arquivo baixado
 */
export async function downloadPixabayAsset(
  downloadUrl: string,
  type: 'video' | 'photo' | 'music' = 'video',
  filename?: string,
): Promise<string> {
  const dir = type === 'music'
    ? MUSIC_ASSETS_DIR
    : resolve(DOWNLOADED_ASSETS_DIR, 'pixabay');

  await mkdir(dir, { recursive: true });

  const extMap = { video: 'mp4', photo: 'jpg', music: 'mp3' };
  const ext = extMap[type];
  const finalName = filename || `${randomUUID()}.${ext}`;
  const localPath = resolve(dir, finalName);

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`[Pixabay] Falha no download: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(localPath, buffer);

  console.log(`[Pixabay] Asset baixado: ${localPath}`);
  return localPath;
}
