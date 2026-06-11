// ============================================================
// Google Image Search — Fallback for specific entities/brands
// Uses Google Custom Search JSON API (free tier: 100 queries/day)
// ============================================================
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_CX = process.env.GOOGLE_CX || '';

export interface WebImage {
  title: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  localPath?: string;
}

/**
 * Search Google Images for specific entities (brands, people, products).
 * Falls back gracefully if no API key is configured.
 */
export async function searchGoogleImages(
  query: string,
  count: number = 5,
): Promise<WebImage[]> {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    console.warn('[GoogleImages] No API key/CX configured. Set GOOGLE_API_KEY and GOOGLE_CX env vars.');
    return [];
  }

  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&searchType=image&num=${count}&imgSize=large&safe=active`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[GoogleImages] API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (!data.items || !Array.isArray(data.items)) {
      return [];
    }

    return data.items.map((item: any) => ({
      title: item.title || '',
      url: item.link || '',
      thumbnailUrl: item.image?.thumbnailLink || item.link,
      width: item.image?.width || 0,
      height: item.image?.height || 0,
    }));
  } catch (error) {
    console.warn(`[GoogleImages] Search failed: ${error}`);
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

  const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
  const filename = `web-${Date.now()}${ext}`;
  const filePath = path.join(dir, filename);

  return new Promise((resolve, reject) => {
    const protocol = imageUrl.startsWith('https') ? https : http;
    const request = protocol.get(imageUrl, { timeout: 15000 }, (response) => {
      // Follow redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadWebImage(redirectUrl, outputDir).then(resolve).catch(reject);
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
        console.log(`[GoogleImages] Downloaded: ${filePath}`);
        resolve(filePath);
      });
      fileStream.on('error', reject);
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}
