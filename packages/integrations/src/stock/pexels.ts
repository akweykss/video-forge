// ============================================================
// @video-forge/integrations — Cliente Pexels (Stock de Vídeos e Fotos)
// ============================================================
import { writeFile, mkdir } from 'fs/promises';
import { resolve, basename } from 'path';
import { randomUUID } from 'crypto';
import { getEnvOrThrow, DOWNLOADED_ASSETS_DIR } from '../config';

const PEXELS_BASE_URL = 'https://api.pexels.com';

/**
 * Vídeo de stock retornado pela API Pexels.
 */
export interface StockVideo {
  /** ID do vídeo no Pexels */
  id: number;
  /** URL da página do vídeo */
  url: string;
  /** URL de download do vídeo (melhor qualidade) */
  downloadUrl: string;
  /** Caminho local após download (se baixado) */
  localPath?: string;
  /** Largura em pixels */
  width: number;
  /** Altura em pixels */
  height: number;
  /** Duração em segundos */
  duration: number;
  /** Fonte: pexels */
  source: 'pexels';
}

/**
 * Foto de stock retornada pela API Pexels.
 */
export interface StockPhoto {
  /** ID da foto no Pexels */
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
  /** Fotógrafo */
  photographer: string;
  /** Fonte: pexels */
  source: 'pexels';
}

/**
 * Executa uma requisição autenticada para a API Pexels.
 * @param endpoint - Caminho do endpoint (ex: /videos/search)
 * @param params - Parâmetros de query string
 * @returns Resposta JSON parseada
 */
async function pexelsFetch<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const apiKey = getEnvOrThrow('PEXELS_API_KEY');
  const queryString = new URLSearchParams(params).toString();
  const url = `${PEXELS_BASE_URL}${endpoint}?${queryString}`;

  const response = await fetch(url, {
    headers: {
      Authorization: apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(
      `[Pexels] Requisição falhou: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Busca vídeos no banco de vídeos Pexels.
 *
 * Retorna vídeos em formato vertical (9:16) quando disponíveis,
 * priorizando qualidade HD.
 *
 * @param query - Termo de busca (em inglês para melhores resultados)
 * @param perPage - Número de resultados por página (padrão: 5)
 * @returns Array de vídeos encontrados
 * @throws Error se a busca falhar
 *
 * @example
 * ```ts
 * const videos = await searchVideos('business meeting');
 * console.log(`${videos.length} vídeos encontrados`);
 * ```
 */
export async function searchVideos(
  query: string,
  perPage: number = 5,
): Promise<StockVideo[]> {
  try {
    console.log(`[Pexels] Buscando vídeos: "${query}"`);

    interface PexelsVideoFile {
      id: number;
      quality: string;
      file_type: string;
      width: number;
      height: number;
      link: string;
    }

    interface PexelsVideo {
      id: number;
      url: string;
      width: number;
      height: number;
      duration: number;
      video_files: PexelsVideoFile[];
    }

    interface PexelsVideoResponse {
      videos: PexelsVideo[];
    }

    const data = await pexelsFetch<PexelsVideoResponse>('/videos/search', {
      query,
      per_page: String(perPage),
      orientation: 'portrait',
    });

    const videos: StockVideo[] = (data.videos ?? []).map((video) => {
      // Seleciona o melhor arquivo de vídeo (HD, portrait quando possível)
      const bestFile = video.video_files
        .filter((f) => f.quality === 'hd' || f.quality === 'sd')
        .sort((a, b) => {
          // Prioriza arquivos verticais
          const aVertical = a.height > a.width ? 1 : 0;
          const bVertical = b.height > b.width ? 1 : 0;
          if (bVertical !== aVertical) return bVertical - aVertical;
          // Depois prioriza qualidade
          return (b.width * b.height) - (a.width * a.height);
        })[0];

      return {
        id: video.id,
        url: video.url,
        downloadUrl: bestFile?.link ?? '',
        width: bestFile?.width ?? video.width,
        height: bestFile?.height ?? video.height,
        duration: video.duration,
        source: 'pexels' as const,
      };
    });

    console.log(`[Pexels] ${videos.length} vídeos encontrados para "${query}"`);
    return videos;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Pexels] Falha na busca de vídeos: ${message}`);
  }
}

/**
 * Busca fotos no banco de imagens Pexels.
 *
 * @param query - Termo de busca (em inglês para melhores resultados)
 * @param perPage - Número de resultados por página (padrão: 5)
 * @returns Array de fotos encontradas
 * @throws Error se a busca falhar
 *
 * @example
 * ```ts
 * const fotos = await searchPhotos('retirement planning');
 * console.log(`${fotos.length} fotos encontradas`);
 * ```
 */
export async function searchPhotos(
  query: string,
  perPage: number = 5,
): Promise<StockPhoto[]> {
  try {
    console.log(`[Pexels] Buscando fotos: "${query}"`);

    interface PexelsSrc {
      original: string;
      large2x: string;
      large: string;
      portrait: string;
    }

    interface PexelsPhoto {
      id: number;
      url: string;
      width: number;
      height: number;
      photographer: string;
      src: PexelsSrc;
    }

    interface PexelsPhotoResponse {
      photos: PexelsPhoto[];
    }

    const data = await pexelsFetch<PexelsPhotoResponse>('/v1/search', {
      query,
      per_page: String(perPage),
      orientation: 'portrait',
    });

    const photos: StockPhoto[] = (data.photos ?? []).map((photo) => ({
      id: photo.id,
      url: photo.url,
      downloadUrl: photo.src.portrait || photo.src.large2x || photo.src.original,
      width: photo.width,
      height: photo.height,
      photographer: photo.photographer,
      source: 'pexels' as const,
    }));

    console.log(`[Pexels] ${photos.length} fotos encontradas para "${query}"`);
    return photos;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Pexels] Falha na busca de fotos: ${message}`);
  }
}

/**
 * Baixa um asset (vídeo ou foto) do Pexels para o diretório local.
 *
 * @param downloadUrl - URL de download do asset
 * @param filename - Nome do arquivo de destino (opcional, gera UUID)
 * @returns Caminho absoluto do arquivo baixado
 */
export async function downloadPexelsAsset(
  downloadUrl: string,
  filename?: string,
): Promise<string> {
  const dir = resolve(DOWNLOADED_ASSETS_DIR, 'pexels');
  await mkdir(dir, { recursive: true });

  const ext = basename(new URL(downloadUrl).pathname).split('.').pop() || 'mp4';
  const finalName = filename || `${randomUUID()}.${ext}`;
  const localPath = resolve(dir, finalName);

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`[Pexels] Falha no download: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(localPath, buffer);

  console.log(`[Pexels] Asset baixado: ${localPath}`);
  return localPath;
}
