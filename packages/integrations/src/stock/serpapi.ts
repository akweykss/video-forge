// ============================================================
// SerpAPI — Google Images search with maximum precision
// Best for: specific brands, products, people, events
// Returns real Google Image results with context
// ============================================================
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const SERPAPI_KEY = process.env.SERPAPI_KEY || '';

export interface SerpImage {
  title: string;
  url: string;          // Full-size image URL
  thumbnailUrl: string;
  width: number;
  height: number;
  source: string;       // Source website
  localPath?: string;
}

/**
 * Search Google Images via SerpAPI for specific entities.
 * Maximum precision: uses Google's actual image search results.
 * 
 * @param query - Search query (English recommended)
 * @param count - Number of results
 */
export async function searchSerpImages(
  query: string,
  count: number = 5,
): Promise<SerpImage[]> {
  if (!SERPAPI_KEY) {
    console.warn('[SerpAPI] No API key. Set SERPAPI_KEY env var.');
    console.warn('[SerpAPI] Get key: https://serpapi.com (100 free/month)');
    return [];
  }

  const url = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(query)}&num=${count}&safe=active&api_key=${SERPAPI_KEY}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[SerpAPI] API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (!data.images_results || !Array.isArray(data.images_results)) {
      return [];
    }

    return data.images_results.slice(0, count).map((item: any) => ({
      title: item.title || '',
      url: item.original || '',
      thumbnailUrl: item.thumbnail || '',
      width: item.original_width || 0,
      height: item.original_height || 0,
      source: item.source || '',
    }));
  } catch (error) {
    console.warn(`[SerpAPI] Search failed: ${error}`);
    return [];
  }
}

/**
 * Validate that a file is actually an image by checking magic bytes.
 * Returns true for JPEG, PNG, GIF, WebP, BMP.
 */
function isValidImage(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);

    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
    // GIF: 47 49 46
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
    // WebP: RIFF....WEBP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
    // BMP: 42 4D
    if (buf[0] === 0x42 && buf[1] === 0x4D) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Download an image from any URL to a local path.
 * Validates Content-Type and magic bytes to ensure it's a real image.
 * Rejects HTML pages, redirects, and corrupt files.
 */
export async function downloadSerpImage(imageUrl: string, outputDir?: string): Promise<string> {
  const dir = outputDir || path.join(process.cwd(), '../../assets/temp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let ext = '.jpg';
  try {
    const urlPath = new URL(imageUrl).pathname;
    const urlExt = path.extname(urlPath);
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(urlExt.toLowerCase())) {
      ext = urlExt;
    }
  } catch { /* use default */ }

  const filename = `serp-${Date.now()}${ext}`;
  const filePath = path.join(dir, filename);

  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl: string, redirects: number = 0) => {
      if (redirects > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const protocol = requestUrl.startsWith('https') ? https : http;
      const req = protocol.get(requestUrl, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      }, (res) => {
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          if (location) {
            const resolvedUrl = location.startsWith('http') ? location : new URL(location, requestUrl).href;
            makeRequest(resolvedUrl, redirects + 1);
            return;
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        // Check Content-Type — reject HTML/text responses
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('text/html') || contentType.includes('text/plain')) {
          res.resume(); // Drain the response
          reject(new Error(`Invalid Content-Type: ${contentType} (expected image)`));
          return;
        }

        const stream = fs.createWriteStream(filePath);
        res.pipe(stream);
        stream.on('finish', () => {
          stream.close();

          // Validate file size (minimum 5KB for a real image)
          const size = fs.statSync(filePath).size;
          if (size < 5000) {
            fs.unlinkSync(filePath);
            reject(new Error(`File too small: ${size} bytes (likely not a real image)`));
            return;
          }

          // Validate magic bytes
          if (!isValidImage(filePath)) {
            fs.unlinkSync(filePath);
            reject(new Error('File is not a valid image (bad magic bytes — possibly HTML)'));
            return;
          }

          console.log(`[SerpAPI] ✅ Downloaded: ${filePath} (${(size / 1024).toFixed(0)}KB)`);
          resolve(filePath);
        });
        stream.on('error', (err) => {
          fs.unlink(filePath, () => {}); // Clean up
          reject(err);
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    };

    makeRequest(imageUrl);
  });
}

/**
 * Search Google Videos via SerpAPI for contextual B-roll footage.
 * Returns video thumbnails (high-quality frames from real videos).
 * 
 * Use for: real events, people in action, specific scenarios
 * Ex: "Neymar playing football" returns actual Neymar footage thumbnails
 */
export interface SerpVideo {
  title: string;
  thumbnailUrl: string;  // High-res video thumbnail (usable as B-roll image)
  videoUrl: string;      // Link to the video page
  duration: string;
  source: string;
}

export async function searchSerpVideos(
  query: string,
  count: number = 5,
): Promise<SerpVideo[]> {
  if (!SERPAPI_KEY) {
    return [];
  }

  const url = `https://serpapi.com/search.json?engine=google_videos&q=${encodeURIComponent(query)}&num=${count}&safe=active&api_key=${SERPAPI_KEY}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[SerpAPI Videos] API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (!data.video_results || !Array.isArray(data.video_results)) {
      return [];
    }

    return data.video_results.slice(0, count).map((item: any) => ({
      title: item.title || '',
      thumbnailUrl: item.thumbnail?.static || item.thumbnail || '',
      videoUrl: item.link || '',
      duration: item.duration || '',
      source: item.source || '',
    }));
  } catch (error) {
    console.warn(`[SerpAPI Videos] Search failed: ${error}`);
    return [];
  }
}
