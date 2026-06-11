// ============================================================
// Smart Image Search — Multi-source search with Claude Vision validation
// Priority: SerpAPI (Google) → Pexels → Pixabay
// Each result is validated by Claude Vision for context accuracy
// ============================================================
import { searchSerpImages, downloadSerpImage } from './serpapi';
import {
  searchPhotos as pexelsSearchPhotos,
  downloadPexelsAsset,
} from './pexels';
import {
  searchPhotos as pixabaySearchPhotos,
  downloadPixabayAsset,
} from './pixabay';

interface SmartImageResult {
  localPath: string;
  source: 'serpapi' | 'pexels' | 'pixabay';
  title: string;
  url: string;
  width: number;
  height: number;
  validationScore?: number;
}

/**
 * Smart image search with context validation.
 * 
 * Flow:
 * 1. Try SerpAPI (Google) first — best for specific entities
 * 2. Fallback to Pexels for generic stock
 * 3. Fallback to Pixabay
 * 4. Claude Vision validates top candidates for context accuracy
 * 
 * @param query - Search query in English
 * @param narrationContext - What the narrator is talking about (for validation)
 * @param validateFn - Optional Claude Vision validation function
 */
export async function smartImageSearch(
  query: string,
  narrationContext: string,
  validateFn?: (imageUrl: string, context: string) => Promise<{ pass: boolean; averageScore: number }>,
): Promise<SmartImageResult | null> {
  const candidates: Array<{
    url: string;
    thumbnailUrl: string;
    title: string;
    width: number;
    height: number;
    source: 'serpapi' | 'pexels' | 'pixabay';
    downloadFn: () => Promise<string>;
  }> = [];

  // === Source 1: SerpAPI (Google Images) — best for specific entities ===
  try {
    const serpResults = await searchSerpImages(query, 5);
    for (const img of serpResults) {
      if (img.url && img.width > 400) {
        candidates.push({
          url: img.url,
          thumbnailUrl: img.thumbnailUrl,
          title: img.title,
          width: img.width,
          height: img.height,
          source: 'serpapi',
          downloadFn: () => downloadSerpImage(img.url),
        });
      }
    }
    if (serpResults.length > 0) {
      console.log(`[SmartSearch] SerpAPI: ${serpResults.length} results for "${query}"`);
    }
  } catch (error) {
    console.warn(`[SmartSearch] SerpAPI failed: ${error}`);
  }

  // === Source 2: Pexels ===
  try {
    const pexelsResults = await pexelsSearchPhotos(query, 5);
    for (const img of pexelsResults) {
      candidates.push({
        url: img.downloadUrl,
        thumbnailUrl: img.downloadUrl,
        title: `Pexels #${img.id}`,
        width: img.width,
        height: img.height,
        source: 'pexels',
        downloadFn: () => downloadPexelsAsset(img.downloadUrl, 'photo'),
      });
    }
  } catch (error) {
    console.warn(`[SmartSearch] Pexels failed: ${error}`);
  }

  // === Source 3: Pixabay ===
  try {
    const pixabayResults = await pixabaySearchPhotos(query, 3);
    for (const img of pixabayResults) {
      candidates.push({
        url: img.downloadUrl,
        thumbnailUrl: img.downloadUrl,
        title: `Pixabay #${img.id}`,
        width: img.width,
        height: img.height,
        source: 'pixabay',
        downloadFn: () => downloadPixabayAsset(img.downloadUrl, 'photo'),
      });
    }
  } catch (error) {
    console.warn(`[SmartSearch] Pixabay failed: ${error}`);
  }

  if (candidates.length === 0) {
    console.warn(`[SmartSearch] No candidates found for "${query}"`);
    return null;
  }

  // Sort: prefer vertical (TikTok), then by source priority
  const sourcePriority = { serpapi: 0, pexels: 1, pixabay: 2 };
  candidates.sort((a, b) => {
    // Prefer vertical images
    const ratioA = a.height / a.width;
    const ratioB = b.height / b.width;
    if (ratioA > 1.2 && ratioB <= 1.2) return -1;
    if (ratioB > 1.2 && ratioA <= 1.2) return 1;
    // Then by source
    return sourcePriority[a.source] - sourcePriority[b.source];
  });

  // === Claude Vision Validation (if available) ===
  if (validateFn) {
    // Validate top 3 candidates, pick the best scoring one
    const top = candidates.slice(0, 3);
    let bestCandidate = top[0];
    let bestScore = 0;

    for (const candidate of top) {
      try {
        const validation = await validateFn(
          candidate.thumbnailUrl || candidate.url,
          `A narração fala sobre: "${narrationContext}". A busca foi: "${query}". Esta imagem faz sentido com o contexto?`,
        );

        console.log(`[SmartSearch] Vision: ${candidate.source} "${candidate.title}" → score ${validation.averageScore.toFixed(1)}, pass: ${validation.pass}`);

        if (validation.pass && validation.averageScore > bestScore) {
          bestScore = validation.averageScore;
          bestCandidate = candidate;
        }
      } catch (error) {
        console.warn(`[SmartSearch] Vision validation failed for ${candidate.source}: ${error}`);
      }
    }

    // Download the best validated candidate
    try {
      const localPath = await bestCandidate.downloadFn();
      console.log(`[SmartSearch] ✅ Selected: ${bestCandidate.source} "${bestCandidate.title}" (score: ${bestScore.toFixed(1)})`);
      return {
        localPath,
        source: bestCandidate.source,
        title: bestCandidate.title,
        url: bestCandidate.url,
        width: bestCandidate.width,
        height: bestCandidate.height,
        validationScore: bestScore,
      };
    } catch (error) {
      console.warn(`[SmartSearch] Download failed, trying next: ${error}`);
    }
  }

  // === No validation: download first candidate ===
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const localPath = await candidate.downloadFn();
      return {
        localPath,
        source: candidate.source,
        title: candidate.title,
        url: candidate.url,
        width: candidate.width,
        height: candidate.height,
      };
    } catch (error) {
      console.warn(`[SmartSearch] Download failed for ${candidate.source}, trying next: ${error}`);
    }
  }

  return null;
}
