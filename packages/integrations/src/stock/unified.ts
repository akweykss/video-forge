import {
  searchVideos as pexelsSearchVideos,
  searchPhotos as pexelsSearchPhotos,
  downloadPexelsAsset,
  type StockVideo,
  type StockPhoto,
} from './pexels';
import {
  searchVideos as pixabaySearchVideos,
  searchPhotos as pixabaySearchPhotos,
  downloadPixabayAsset,
  type PixabayStockVideo,
  type PixabayStockPhoto,
} from './pixabay';
import {
  searchGoogleImages,
  downloadWebImage,
} from './google-images';
import {
  searchSerpImages,
  downloadSerpImage,
  searchSerpVideos,
} from './serpapi';
import {
  findTMDBImages,
  downloadTMDBImage,
} from './tmdb';

/**
 * Vídeo unificado de stock (compatível com Pexels e Pixabay).
 */
export interface UnifiedStockVideo {
  id: number;
  url: string;
  downloadUrl: string;
  localPath?: string;
  width: number;
  height: number;
  duration: number;
  source: 'pexels' | 'pixabay';
}

/**
 * Foto unificada de stock (compatível com Pexels e Pixabay).
 */
export interface UnifiedStockPhoto {
  id: number;
  url: string;
  downloadUrl: string;
  localPath?: string;
  width: number;
  height: number;
  source: 'pexels' | 'pixabay';
}

/**
 * Converte um vídeo Pixabay para o formato unificado.
 */
function pixabayVideoToUnified(v: PixabayStockVideo): UnifiedStockVideo {
  return {
    id: v.id,
    url: v.url,
    downloadUrl: v.downloadUrl,
    width: v.width,
    height: v.height,
    duration: v.duration,
    source: 'pixabay',
  };
}

/**
 * Converte uma foto Pixabay para o formato unificado.
 */
function pixabayPhotoToUnified(p: PixabayStockPhoto): UnifiedStockPhoto {
  return {
    id: p.id,
    url: p.url,
    downloadUrl: p.downloadUrl,
    width: p.width,
    height: p.height,
    source: 'pixabay',
  };
}

/**
 * Detects if a query contains specific entities (names, brands, places)
 * that would return bad results on generic stock sites (Pexels/Pixabay).
 *
 * These queries should go to SerpAPI for real-world accuracy.
 */
function hasSpecificEntity(query: string): boolean {
  // Count capitalized words (proper nouns) — more than 1 suggests entity
  const words = query.split(/\s+/);
  const capitalizedWords = words.filter(w => w.length > 2 && /^[A-Z]/.test(w));
  if (capitalizedWords.length >= 2) return true;

  // Check for known entity patterns
  const entityPatterns = [
    // People
    /\b(neymar|messi|ronaldo|mbapp[eé]|lebron|jordan|trump|biden|lula|bolsonaro)\b/i,
    // Brands
    /\b(nike|adidas|apple|samsung|tesla|google|amazon|coca.cola|ferrari|bmw|mercedes)\b/i,
    // Specific places/events
    /\b(world cup|champions league|super bowl|olympics|grammy|oscar|ballon d.or)\b/i,
    // Movies/series (handled by TMDB but may still come here)
    /\b(netflix|hbo|disney|marvel|dc|pixar)\b/i,
  ];

  return entityPatterns.some(p => p.test(query));
}

/**
 * Creates a generic B-roll query from a specific one.
 * Strips proper nouns and keeps only descriptive words.
 * "Neymar dribbling football stadium" → "football stadium action"
 */
function makeGenericQuery(query: string): string {
  // Keep all lowercase words and numbers (strip only Capitalized proper nouns)
  const words = query.split(/\s+/);
  const genericWords = words
    .filter(w => {
      if (w.length <= 2) return false;
      if (/^[A-Z][a-z]/.test(w)) return false; // Proper noun like "Neymar"
      if (/^[A-Z]+$/.test(w) && w.length <= 4) return false; // Acronyms like "FC", "NBA"
      return true;
    })
    .join(' ');

  // If we stripped too much, add contextual fallbacks
  if (genericWords.length < 8) {
    const queryLower = query.toLowerCase();
    // Add context based on common patterns
    if (queryLower.match(/football|soccer|goal|dribbl/)) return 'football match stadium action cinematic';
    if (queryLower.match(/basketball|nba|dunk/)) return 'basketball court game action cinematic';
    if (queryLower.match(/shoe|sneaker|air max/)) return 'athletic shoes product closeup cinematic';
    if (queryLower.match(/cup|champion|world|final/)) return 'sports championship celebration trophy cinematic';
    if (queryLower.match(/car|speed|race|formula/)) return 'race car speed track cinematic';
    return `${genericWords} cinematic aerial`;
  }

  return genericWords;
}

export async function findBRoll(query: string): Promise<UnifiedStockVideo> {
  console.log(`[Stock] Buscando B-roll: "${query}"`);

  const isEntity = hasSpecificEntity(query);

  // ── ENTITY QUERIES: SerpAPI FIRST (real-world accuracy) ──
  if (isEntity) {
    console.log(`[Stock] 🎯 Entidade detectada — SerpAPI primeiro para: "${query}"`);

    // Try SerpAPI video thumbnails (best for specific entities)
    try {
      const serpVideos = await searchSerpVideos(query, 5);
      if (serpVideos.length > 0) {
        for (const video of serpVideos) {
          if (video.thumbnailUrl) {
            try {
              const localPath = await downloadSerpImage(video.thumbnailUrl);
              console.log(`[Stock] ✅ B-roll SerpAPI (entity): "${video.title}"`);
              return {
                id: Date.now(), url: video.videoUrl, downloadUrl: video.thumbnailUrl,
                localPath, width: 1920, height: 1080, duration: 3, source: 'pexels' as const,
              };
            } catch { continue; }
          }
        }
      }
    } catch (error) {
      console.warn(`[Stock] SerpAPI Videos falhou: ${error}`);
    }

    // SerpAPI Images fallback for entities
    try {
      const serpImages = await searchSerpImages(query, 5);
      if (serpImages.length > 0) {
        for (const img of serpImages) {
          try {
            const localPath = await downloadSerpImage(img.original);
            console.log(`[Stock] ✅ B-roll SerpAPI (entity image): "${img.title}"`);
            return {
              id: Date.now(), url: img.original, downloadUrl: img.original,
              localPath, width: img.width, height: img.height, duration: 3, source: 'pexels' as const,
            };
          } catch { continue; }
        }
      }
    } catch (error) {
      console.warn(`[Stock] SerpAPI Images falhou: ${error}`);
    }
  }

  // ── GENERIC QUERIES: Pexels/Pixabay (clean, no-watermark video) ──
  // For entities, use a cleaned generic version of the query
  const pexelsQuery = isEntity ? makeGenericQuery(query) : query;
  console.log(`[Stock] Pexels/Pixabay query: "${pexelsQuery}"`);

  // Pexels (best quality for vertical video)
  try {
    const pexelsResults = await pexelsSearchVideos(pexelsQuery, 5);
    if (pexelsResults.length > 0) {
      const sorted = [...pexelsResults].sort((a, b) => {
        const ratioA = a.height / a.width;
        const ratioB = b.height / b.width;
        return ratioB - ratioA;
      });
      const best = sorted[0];
      const localPath = await downloadPexelsAsset(best.downloadUrl);
      console.log(`[Stock] B-roll Pexels: ${best.id} (${best.width}x${best.height})`);
      return {
        id: best.id, url: best.url, downloadUrl: best.downloadUrl,
        localPath, width: best.width, height: best.height, duration: best.duration, source: 'pexels',
      };
    }
  } catch (error) {
    console.warn(`[Stock] Pexels falhou: ${error}`);
  }

  // Pixabay fallback
  try {
    const pixabayResults = await pixabaySearchVideos(pexelsQuery, 3);
    if (pixabayResults.length > 0) {
      const best = pixabayResults[0];
      const localPath = await downloadPixabayAsset(best.downloadUrl, 'video');
      console.log(`[Stock] B-roll Pixabay: ${best.id}`);
      return { ...pixabayVideoToUnified(best), localPath };
    }
  } catch (error) {
    console.warn(`[Stock] Pixabay falhou: ${error}`);
  }

  // ── NON-ENTITY: also try SerpAPI as last resort ──
  if (!isEntity) {
    try {
      const serpImages = await searchSerpImages(query, 5);
      if (serpImages.length > 0) {
        const best = serpImages[0];
        const localPath = await downloadSerpImage(best.original || best.url);
        console.log(`[Stock] B-roll SerpAPI (fallback image): "${best.title}"`);
        return {
          id: Date.now(), url: best.original || best.url, downloadUrl: best.original || best.url,
          localPath, width: best.width, height: best.height, duration: 3, source: 'pexels' as const,
        };
      }
    } catch (error) {
      console.warn(`[Stock] SerpAPI Images falhou: ${error}`);
    }
  }

  throw new Error(
    `[Stock] Nenhum B-roll encontrado para: "${query}". ` +
    `Tente uma busca diferente em inglês.`
  );
}

/**
 * Busca uma foto combinando SerpAPI (Google), Pexels e Pixabay com fallback.
 *
 * Priority: SerpAPI → Pexels → Pixabay → Google Custom Search
 * SerpAPI is best for specific entities (brands, products, people).
 *
 * @param query - Termo de busca para a foto
 * @returns A melhor foto encontrada com download realizado
 * @throws Error se nenhuma foto for encontrada
 *
 * @example
 * ```ts
 * const foto = await findImage('elderly retirement happy');
 * console.log(`Foto baixada: ${foto.localPath}`);
 * ```
 */
export async function findImage(query: string): Promise<UnifiedStockPhoto> {
  console.log(`[Stock] Buscando imagem: "${query}"`);

  // ── Detect if query is likely a movie/series ──────────────
  const movieKeywords = [
    'movie', 'film', 'series', 'tv show', 'season', 'episode',
    'netflix', 'hbo', 'disney', 'marvel', 'dc comics', 'anime',
    'actor', 'actress', 'director', 'cast',
    // Common series/film patterns
    'breaking bad', 'stranger things', 'game of thrones', 'the walking dead',
    'house of the dragon', 'the witcher', 'squid game', 'money heist',
    'narcos', 'peaky blinders', 'dark', 'black mirror',
    'the mandalorian', 'loki', 'wandavision',
    'harry potter', 'lord of the rings', 'star wars',
    'avengers', 'spider-man', 'batman', 'superman',
    'john wick', 'fast and furious', 'mission impossible',
    'the godfather', 'pulp fiction', 'inception', 'interstellar',
    'oppenheimer', 'barbie',
  ];
  const queryLower = query.toLowerCase();
  const isTMDBQuery = movieKeywords.some(kw => queryLower.includes(kw));

  // ── Priority 0: TMDB FIRST for movie/series queries ───────
  if (isTMDBQuery) {
    console.log(`[Stock] 🎬 Query parece ser filme/série — tentando TMDB primeiro: "${query}"`);
    try {
      const tmdbImages = await findTMDBImages(query, 5);
      if (tmdbImages.length > 0) {
        for (const candidate of tmdbImages) {
          try {
            const localPath = await downloadTMDBImage(candidate.filePath);
            console.log(`[Stock] ✅ Imagem TMDB (Priority 0): ${candidate.url}`);
            return {
              id: Date.now(),
              url: candidate.url,
              downloadUrl: candidate.url,
              localPath,
              width: candidate.width,
              height: candidate.height,
              source: 'pexels' as const,
            };
          } catch (dlError) {
            console.warn(`[Stock] TMDB download failed: ${dlError}`);
            continue;
          }
        }
      }
    } catch (error) {
      console.warn(`[Stock] TMDB (Priority 0) falhou: ${error}`);
    }
  }

  // Priority 1: SerpAPI (Google Images) — best for specific entities
  try {
    const serpResults = await searchSerpImages(query, 5);
    if (serpResults.length > 0) {
      // Prefer vertical
      const sorted = [...serpResults].sort((a, b) => {
        const ratioA = a.height / a.width;
        const ratioB = b.height / b.width;
        return ratioB - ratioA;
      });
      // Try each result — some may be HTML/corrupt
      for (const candidate of sorted) {
        try {
          const localPath = await downloadSerpImage(candidate.url);
          console.log(`[Stock] Imagem SerpAPI (Google): "${candidate.title}"`);
          return {
            id: Date.now(),
            url: candidate.url,
            downloadUrl: candidate.url,
            localPath,
            width: candidate.width,
            height: candidate.height,
            source: 'pexels' as const,
          };
        } catch (dlError) {
          console.warn(`[Stock] SerpAPI download failed for "${candidate.title}": ${dlError}`);
          continue; // Try next candidate
        }
      }
    }
  } catch (error) {
    console.warn(`[Stock] SerpAPI falhou, tentando TMDB... (${error})`);
  }

  // Priority 2: TMDB fallback (for non-movie queries too — might still match)
  if (!isTMDBQuery) {
    try {
      const tmdbImages = await findTMDBImages(query, 3);
      if (tmdbImages.length > 0) {
        for (const candidate of tmdbImages) {
          try {
            const localPath = await downloadTMDBImage(candidate.filePath);
            console.log(`[Stock] Imagem TMDB (fallback): ${candidate.url}`);
            return {
              id: Date.now(),
              url: candidate.url,
              downloadUrl: candidate.url,
              localPath,
              width: candidate.width,
              height: candidate.height,
              source: 'pexels' as const,
            };
          } catch (dlError) {
            console.warn(`[Stock] TMDB download failed: ${dlError}`);
            continue;
          }
        }
      }
    } catch (error) {
      console.warn(`[Stock] TMDB falhou, tentando Pexels... (${error})`);
    }
  }

  // Priority 3: Pexels
  try {
    const pexelsResults = await pexelsSearchPhotos(query, 5);
    if (pexelsResults.length > 0) {
      // Prefer vertical/portrait photos for TikTok/Reels
      const sorted = [...pexelsResults].sort((a, b) => {
        const ratioA = a.height / a.width;
        const ratioB = b.height / b.width;
        return ratioB - ratioA;
      });
      const best = sorted[0];
      const localPath = await downloadPexelsAsset(best.downloadUrl);
      console.log(`[Stock] Imagem encontrada no Pexels: ${best.id} (${best.width}x${best.height})`);
      return {
        id: best.id,
        url: best.url,
        downloadUrl: best.downloadUrl,
        localPath,
        width: best.width,
        height: best.height,
        source: 'pexels',
      };
    }
  } catch (error) {
    console.warn(`[Stock] Pexels falhou, tentando Pixabay... (${error})`);
  }

  // Priority 4: Pixabay
  try {
    const pixabayResults = await pixabaySearchPhotos(query, 3);
    if (pixabayResults.length > 0) {
      const best = pixabayResults[0];
      const localPath = await downloadPixabayAsset(best.downloadUrl, 'photo');
      console.log(`[Stock] Imagem encontrada no Pixabay: ${best.id}`);
      return {
        ...pixabayPhotoToUnified(best),
        localPath,
      };
    }
  } catch (error) {
    console.warn(`[Stock] Pixabay também falhou: ${error}`);
  }

  // Priority 5: Google Images (for specific brands, products, people)
  try {
    const googleResults = await searchGoogleImages(query, 5);
    if (googleResults.length > 0) {
      // Prefer vertical images
      const sorted = [...googleResults].sort((a, b) => {
        const ratioA = a.height / a.width;
        const ratioB = b.height / b.width;
        return ratioB - ratioA;
      });
      const best = sorted[0];
      const localPath = await downloadWebImage(best.url);
      console.log(`[Stock] Imagem encontrada no Google: "${best.title}"`);
      return {
        id: Date.now(),
        url: best.url,
        downloadUrl: best.url,
        localPath,
        width: best.width,
        height: best.height,
        source: 'pexels' as const, // compatible type
      };
    }
  } catch (error) {
    console.warn(`[Stock] Google Images também falhou: ${error}`);
  }

  throw new Error(
    `[Stock] Nenhuma imagem encontrada para: "${query}". ` +
    `Tente uma busca diferente em inglês.`
  );
}
