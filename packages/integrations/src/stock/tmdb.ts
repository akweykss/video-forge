// ============================================================
// TMDB — The Movie Database API client
// Best for: movie/series backdrops, episode stills, cast photos
// High-quality cinematic images from official movie/TV databases
// ============================================================
import { downloadSerpImage } from './serpapi';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';

/** Read API key lazily — dotenv may not have run at import time */
function getTMDBKey(): string {
  return process.env.TMDB_API_KEY || '';
}

// ── Types ────────────────────────────────────────────────────

/**
 * A movie or TV series result from TMDB search.
 */
export interface TMDBResult {
  /** TMDB ID */
  id: number;
  /** Title (movie) or name (TV) */
  title: string;
  /** 'movie' or 'tv' */
  mediaType: 'movie' | 'tv';
  /** Release year */
  year: string;
  /** Overview / synopsis */
  overview: string;
  /** Poster image path (relative) */
  posterPath: string | null;
  /** Backdrop image path (relative) */
  backdropPath: string | null;
  /** Vote average (0-10) */
  voteAverage: number;
}

/**
 * A TMDB image (backdrop, still, or profile).
 */
export interface TMDBImage {
  /** Relative image path on TMDB */
  filePath: string;
  /** Full URL at w1280 size */
  url: string;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Aspect ratio */
  aspectRatio: number;
  /** Vote average for this image */
  voteAverage: number;
  /** Local path after download */
  localPath?: string;
}

/**
 * A cast member with profile photo.
 */
export interface TMDBCastMember {
  /** TMDB person ID */
  id: number;
  /** Actor/actress name */
  name: string;
  /** Character name */
  character: string;
  /** Profile photo path (relative) */
  profilePath: string | null;
  /** Full profile photo URL */
  profileUrl: string | null;
  /** Order in credits */
  order: number;
}

// ── Internal helpers ─────────────────────────────────────────

/**
 * Executes an authenticated request to the TMDB API.
 */
async function tmdbFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const apiKey = getTMDBKey();
  if (!apiKey) {
    throw new Error('[TMDB] No API key. Set TMDB_API_KEY env var.');
  }

  const searchParams = new URLSearchParams({ api_key: apiKey, ...params });
  const url = `${TMDB_BASE_URL}${endpoint}?${searchParams.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`[TMDB] API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Builds a full TMDB image URL from a relative path and size.
 */
function buildImageUrl(filePath: string, size: 'w780' | 'w1280' | 'original' = 'w1280'): string {
  return `${TMDB_IMAGE_BASE}${size}${filePath}`;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Search for a movie or TV series by name.
 *
 * @param query - Search query (English recommended)
 * @param type - 'movie', 'tv', or 'multi' (default: 'multi')
 * @returns Array of search results
 *
 * @example
 * ```ts
 * const results = await searchTMDB('Breaking Bad');
 * console.log(results[0].title); // "Breaking Bad"
 * ```
 */
export async function searchTMDB(
  query: string,
  type: 'movie' | 'tv' | 'multi' = 'multi',
): Promise<TMDBResult[]> {
  if (!getTMDBKey()) {
    console.warn('[TMDB] No API key. Set TMDB_API_KEY env var.');
    return [];
  }

  try {
    const endpoint = `/search/${type}`;

    interface TMDBSearchItem {
      id: number;
      title?: string;
      name?: string;
      media_type?: string;
      release_date?: string;
      first_air_date?: string;
      overview?: string;
      poster_path?: string | null;
      backdrop_path?: string | null;
      vote_average?: number;
    }

    interface TMDBSearchResponse {
      results: TMDBSearchItem[];
    }

    const data = await tmdbFetch<TMDBSearchResponse>(endpoint, {
      query,
      language: 'en-US',
      page: '1',
    });

    if (!data.results || !Array.isArray(data.results)) {
      return [];
    }

    // Filter to only movie and tv results (multi can return people)
    const filtered = type === 'multi'
      ? data.results.filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
      : data.results;

    return filtered.map((item) => {
      const mediaType: 'movie' | 'tv' = type === 'multi'
        ? (item.media_type as 'movie' | 'tv')
        : type;
      const dateStr = mediaType === 'movie' ? item.release_date : item.first_air_date;

      return {
        id: item.id,
        title: item.title || item.name || '',
        mediaType,
        year: dateStr ? dateStr.substring(0, 4) : '',
        overview: item.overview || '',
        posterPath: item.poster_path || null,
        backdropPath: item.backdrop_path || null,
        voteAverage: item.vote_average || 0,
      };
    });
  } catch (error) {
    console.warn(`[TMDB] Search failed: ${error}`);
    return [];
  }
}

/**
 * Get high-quality backdrop images for a movie or TV series.
 *
 * @param id - TMDB movie or TV series ID
 * @param type - 'movie' or 'tv'
 * @returns Array of backdrop images sorted by vote average
 *
 * @example
 * ```ts
 * const backdrops = await getTMDBBackdrops(1396, 'tv'); // Breaking Bad
 * console.log(backdrops[0].url);
 * ```
 */
export async function getTMDBBackdrops(
  id: number,
  type: 'movie' | 'tv',
): Promise<TMDBImage[]> {
  interface TMDBImageItem {
    file_path: string;
    width: number;
    height: number;
    aspect_ratio: number;
    vote_average: number;
  }

  interface TMDBImagesResponse {
    backdrops: TMDBImageItem[];
  }

  try {
    const data = await tmdbFetch<TMDBImagesResponse>(`/${type}/${id}/images`, {
      include_image_language: 'en,null',
    });

    if (!data.backdrops || !Array.isArray(data.backdrops)) {
      return [];
    }

    return data.backdrops
      .sort((a, b) => b.vote_average - a.vote_average)
      .map((img) => ({
        filePath: img.file_path,
        url: buildImageUrl(img.file_path, 'w1280'),
        width: img.width,
        height: img.height,
        aspectRatio: img.aspect_ratio,
        voteAverage: img.vote_average,
      }));
  } catch (error) {
    console.warn(`[TMDB] Failed to get backdrops for ${type}/${id}: ${error}`);
    return [];
  }
}

/**
 * Get episode stills for a TV series episode.
 *
 * @param seriesId - TMDB TV series ID
 * @param seasonNum - Season number
 * @param episodeNum - Episode number
 * @returns Array of episode still images
 *
 * @example
 * ```ts
 * const stills = await getTMDBStills(1396, 5, 16); // Breaking Bad S05E16
 * ```
 */
export async function getTMDBStills(
  seriesId: number,
  seasonNum: number,
  episodeNum: number,
): Promise<TMDBImage[]> {
  interface TMDBImageItem {
    file_path: string;
    width: number;
    height: number;
    aspect_ratio: number;
    vote_average: number;
  }

  interface TMDBStillsResponse {
    stills: TMDBImageItem[];
  }

  try {
    const data = await tmdbFetch<TMDBStillsResponse>(
      `/tv/${seriesId}/season/${seasonNum}/episode/${episodeNum}/images`,
    );

    if (!data.stills || !Array.isArray(data.stills)) {
      return [];
    }

    return data.stills
      .sort((a, b) => b.vote_average - a.vote_average)
      .map((img) => ({
        filePath: img.file_path,
        url: buildImageUrl(img.file_path, 'w1280'),
        width: img.width,
        height: img.height,
        aspectRatio: img.aspect_ratio,
        voteAverage: img.vote_average,
      }));
  } catch (error) {
    console.warn(`[TMDB] Failed to get stills for tv/${seriesId}/S${seasonNum}E${episodeNum}: ${error}`);
    return [];
  }
}

/**
 * Get cast photos for a movie or TV series.
 *
 * @param id - TMDB movie or TV series ID
 * @param type - 'movie' or 'tv'
 * @returns Array of cast members with profile photos
 *
 * @example
 * ```ts
 * const cast = await getTMDBCast(1396, 'tv'); // Breaking Bad cast
 * console.log(cast[0].name); // "Bryan Cranston"
 * ```
 */
export async function getTMDBCast(
  id: number,
  type: 'movie' | 'tv',
): Promise<TMDBCastMember[]> {
  interface TMDBCastItem {
    id: number;
    name: string;
    character: string;
    profile_path: string | null;
    order: number;
  }

  interface TMDBCreditsResponse {
    cast: TMDBCastItem[];
  }

  try {
    const data = await tmdbFetch<TMDBCreditsResponse>(`/${type}/${id}/credits`);

    if (!data.cast || !Array.isArray(data.cast)) {
      return [];
    }

    return data.cast
      .sort((a, b) => a.order - b.order)
      .map((member) => ({
        id: member.id,
        name: member.name,
        character: member.character,
        profilePath: member.profile_path,
        profileUrl: member.profile_path
          ? buildImageUrl(member.profile_path, 'w780')
          : null,
        order: member.order,
      }));
  } catch (error) {
    console.warn(`[TMDB] Failed to get cast for ${type}/${id}: ${error}`);
    return [];
  }
}

/**
 * Download a TMDB image to a local path.
 * Reuses downloadSerpImage for validation (Content-Type + magic bytes check).
 *
 * @param imagePath - Relative TMDB image path (e.g. "/abc123.jpg")
 * @param size - Image size: 'w780', 'w1280', or 'original' (default: 'w1280')
 * @returns Local file path of the downloaded image
 *
 * @example
 * ```ts
 * const localPath = await downloadTMDBImage('/abc123.jpg', 'original');
 * ```
 */
export async function downloadTMDBImage(
  imagePath: string,
  size: 'w780' | 'w1280' | 'original' = 'w1280',
): Promise<string> {
  const fullUrl = buildImageUrl(imagePath, size);
  console.log(`[TMDB] Downloading image: ${fullUrl}`);
  return downloadSerpImage(fullUrl);
}

/**
 * Get poster images for a movie or TV series.
 * Posters are PORTRAIT oriented (2:3 ratio) — perfect for 9:16 TikTok!
 */
export async function getTMDBPosters(
  id: number,
  type: 'movie' | 'tv',
): Promise<TMDBImage[]> {
  interface TMDBImageItem {
    file_path: string;
    width: number;
    height: number;
    aspect_ratio: number;
    vote_average: number;
  }

  interface TMDBImagesResponse {
    posters: TMDBImageItem[];
  }

  try {
    const data = await tmdbFetch<TMDBImagesResponse>(`/${type}/${id}/images`, {
      include_image_language: 'en,null',
    });

    if (!data.posters || !Array.isArray(data.posters)) {
      return [];
    }

    return data.posters
      .filter(img => img.width >= 500) // minimum quality
      .sort((a, b) => b.vote_average - a.vote_average)
      .map((img) => ({
        filePath: img.file_path,
        url: buildImageUrl(img.file_path, 'w1280'),
        width: img.width,
        height: img.height,
        aspectRatio: img.aspect_ratio,
        voteAverage: img.vote_average,
      }));
  } catch (error) {
    console.warn(`[TMDB] Failed to get posters for ${type}/${id}: ${error}`);
    return [];
  }
}

/**
 * Score an image for 9:16 vertical video suitability.
 * Higher = better for TikTok/Reels.
 */
function score916(img: TMDBImage): number {
  let score = 0;

  // 1. Portrait orientation BONUS (+50 for posters, they're already vertical!)
  if (img.height > img.width) {
    score += 50; // Portrait = great for 9:16
  }

  // 2. Resolution score (0-20)
  const megapixels = (img.width * img.height) / 1_000_000;
  score += Math.min(20, megapixels * 5);

  // 3. Vote average score (0-15)
  score += (img.voteAverage / 10) * 15;

  // 4. Aspect ratio suitability for 9:16 crop
  //    - 2:3 (0.667) = perfect portrait, no crop needed → +20
  //    - 16:9 (1.778) = landscape, needs heavy crop → +5
  //    - Close to 1:1 = decent, moderate crop → +10
  const ratio = img.width / img.height;
  if (ratio < 0.8) {
    score += 20; // Already portrait
  } else if (ratio < 1.2) {
    score += 12; // Near square
  } else if (ratio < 1.5) {
    score += 8;  // Mild landscape
  } else {
    score += 5;  // Wide landscape (16:9)
  }

  // 5. Minimum resolution gate (penalize tiny images)
  if (img.width < 780 && img.height < 780) {
    score -= 20;
  }

  return score;
}

/**
 * Smart search: search TMDB + get best images scored for 9:16 format.
 *
 * Strategy:
 * 1. Search TMDB for the query
 * 2. Get BOTH backdrops (landscape) AND posters (portrait!)
 * 3. If TV series, also get stills from popular episodes
 * 4. Score all images for 9:16 suitability
 * 5. Return top N sorted by score
 *
 * @param query - Search query (movie or TV series name)
 * @param count - Maximum number of images to return (default: 5)
 * @returns Array of images scored and sorted for 9:16 video usage
 */
export async function findTMDBImages(
  query: string,
  count: number = 5,
): Promise<TMDBImage[]> {
  if (!getTMDBKey()) {
    console.warn('[TMDB] No API key. Set TMDB_API_KEY env var.');
    return [];
  }

  try {
    // Search for the query
    const results = await searchTMDB(query);
    if (results.length === 0) {
      console.warn(`[TMDB] No results found for: "${query}"`);
      return [];
    }

    // Pick the best result (highest vote average among top results)
    const best = results
      .slice(0, 5)
      .sort((a, b) => b.voteAverage - a.voteAverage)[0];

    console.log(`[TMDB] Best match: "${best.title}" (${best.year}) [${best.mediaType}] — ID: ${best.id}`);

    // Collect ALL image types in parallel
    const [backdrops, posters] = await Promise.all([
      getTMDBBackdrops(best.id, best.mediaType),
      getTMDBPosters(best.id, best.mediaType),
    ]);

    // Also try stills for TV series (first few episodes)
    let stills: TMDBImage[] = [];
    if (best.mediaType === 'tv') {
      try {
        // Get stills from S01E01 and S01E02 (most iconic episodes)
        const [s1, s2] = await Promise.all([
          getTMDBStills(best.id, 1, 1),
          getTMDBStills(best.id, 1, 2),
        ]);
        stills = [...s1, ...s2];
      } catch { /* stills are optional */ }
    }

    // Merge all candidates
    const allCandidates = [...posters, ...backdrops, ...stills];

    if (allCandidates.length === 0) {
      console.warn(`[TMDB] No images found for "${best.title}"`);
      return [];
    }

    // Score all for 9:16 suitability
    const scored = allCandidates
      .map(img => ({ img, score: score916(img) }))
      .sort((a, b) => b.score - a.score);

    // Log top candidates for debugging
    console.log(`[TMDB] 📊 Image selection for "${best.title}":`);
    console.log(`  Total: ${allCandidates.length} (${posters.length} posters, ${backdrops.length} backdrops, ${stills.length} stills)`);
    scored.slice(0, 5).forEach((s, i) => {
      const type = s.img.height > s.img.width ? '📱 PORTRAIT' : '🖥 LANDSCAPE';
      console.log(`  ${i+1}. Score: ${s.score.toFixed(1)} | ${s.img.width}x${s.img.height} | ${type} | vote: ${s.img.voteAverage}`);
    });

    // Return top N
    const selected = scored.slice(0, count).map(s => s.img);
    console.log(`[TMDB] ✅ Selected top ${selected.length} images (best score: ${scored[0].score.toFixed(1)})`);
    return selected;
  } catch (error) {
    console.warn(`[TMDB] findTMDBImages failed: ${error}`);
    return [];
  }
}

