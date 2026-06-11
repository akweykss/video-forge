// ============================================================
// Bing Image Search — Busca imagens na web inteira
// Melhor para: marcas, produtos, pessoas reais, eventos
// Free tier: 1.000 buscas/mês
// ============================================================
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const BING_API_KEY = process.env.BING_API_KEY || '';
const BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/images/search';

export interface WebImage {
  title: string;
  url: string;        // Full-size image URL
  thumbnailUrl: string;
  width: number;
  height: number;
  hostPage: string;    // Source page
  localPath?: string;
}

export interface WebVideo {
  title: string;
  url: string;         // Video page URL
  thumbnailUrl: string;
  contentUrl: string;  // Direct video URL
  width: number;
  height: number;
  duration: string;
  hostPage: string;
  localPath?: string;
}

/**
 * Search Bing Images for specific entities (brands, people, products, events).
 * Searches the ENTIRE web — no configuration needed.
 * 
 * @param query - Search query in English for best results
 * @param count - Number of results (max 50)
 * @param preferVertical - Prefer portrait/vertical images (for TikTok/Reels)
 */
export async function searchWebImages(
  query: string,
  count: number = 5,
  preferVertical: boolean = true,
): Promise<WebImage[]> {
  if (!BING_API_KEY) {
    console.warn('[BingImages] No API key. Set BING_API_KEY env var.');
    console.warn('[BingImages] Get free key: https://portal.azure.com → Bing Search v7');
    return [];
  }

  const aspect = preferVertical ? '&aspect=Tall' : '';
  const url = `${BING_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}&mkt=pt-BR&safeSearch=Moderate&imageType=Photo${aspect}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Ocp-Apim-Subscription-Key': BING_API_KEY,
      },
    });

    if (!response.ok) {
      console.warn(`[BingImages] API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    if (!data.value || !Array.isArray(data.value)) {
      return [];
    }

    return data.value.map((item: any) => ({
      title: item.name || '',
      url: item.contentUrl || '',
      thumbnailUrl: item.thumbnailUrl || '',
      width: item.width || 0,
      height: item.height || 0,
      hostPage: item.hostPageUrl || '',
    }));
  } catch (error) {
    console.warn(`[BingImages] Search failed: ${error}`);
    return [];
  }
}

/**
 * Search Bing Videos for contextual real footage.
 * 
 * @param query - Search query in English
 * @param count - Number of results
 */
export async function searchWebVideos(
  query: string,
  count: number = 3,
): Promise<WebVideo[]> {
  if (!BING_API_KEY) {
    return [];
  }

  const url = `https://api.bing.microsoft.com/v7.0/videos/search?q=${encodeURIComponent(query)}&count=${count}&mkt=pt-BR&safeSearch=Moderate`;

  try {
    const response = await fetch(url, {
      headers: {
        'Ocp-Apim-Subscription-Key': BING_API_KEY,
      },
    });

    if (!response.ok) return [];

    const data = await response.json();
    if (!data.value) return [];

    return data.value.map((item: any) => ({
      title: item.name || '',
      url: item.contentUrl || item.hostPageUrl || '',
      thumbnailUrl: item.thumbnailUrl || '',
      contentUrl: item.contentUrl || '',
      width: item.width || 0,
      height: item.height || 0,
      duration: item.duration || '',
      hostPage: item.hostPageUrl || '',
    }));
  } catch (error) {
    console.warn(`[BingVideos] Search failed: ${error}`);
    return [];
  }
}

/**
 * Download an image from any URL to a local path.
 */
export async function downloadWebImage(imageUrl: string, outputDir?: string): Promise<string> {
  const dir = outputDir || path.join(process.cwd(), '../../assets/temp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Extract extension from URL, default to .jpg
  let ext = '.jpg';
  try {
    const urlPath = new URL(imageUrl).pathname;
    const urlExt = path.extname(urlPath);
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(urlExt.toLowerCase())) {
      ext = urlExt;
    }
  } catch { /* use default */ }

  const filename = `web-${Date.now()}${ext}`;
  const filePath = path.join(dir, filename);

  return new Promise((resolve, reject) => {
    const makeRequest = (url: string, redirectCount: number = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const protocol = url.startsWith('https') ? https : http;
      const request = protocol.get(url, { 
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VideoForge/1.0)',
        },
      }, (response) => {
        // Follow redirects
        if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            makeRequest(redirectUrl, redirectCount + 1);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(filePath);
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          console.log(`[WebSearch] Downloaded: ${filePath} (${fs.statSync(filePath).size} bytes)`);
          resolve(filePath);
        });
        fileStream.on('error', reject);
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Download timeout'));
      });
    };

    makeRequest(imageUrl);
  });
}
