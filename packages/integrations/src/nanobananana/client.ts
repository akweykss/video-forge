// ============================================================
// @video-forge/integrations — Cliente Nano Banana Pro (Google GenAI)
// Gera imagens de alta qualidade usando múltiplos modelos
// ============================================================
import { GoogleGenAI } from '@google/genai';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getEnvOrThrow, GENERATED_ASSETS_DIR } from '../config';

export interface GeneratedImage {
  url: string;
  localPath: string;
}

let clientInstance: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!clientInstance) {
    clientInstance = new GoogleGenAI({
      apiKey: getEnvOrThrow('GOOGLE_AI_API_KEY'),
    });
  }
  return clientInstance;
}

async function ensureOutputDir(): Promise<void> {
  await mkdir(GENERATED_ASSETS_DIR, { recursive: true });
}

/**
 * Gera uma imagem usando Nano Banana Pro (Google AI Studio).
 * Fallback chain: nano-banana-pro-preview → imagen-4.0-fast → gemini-2.5-flash-image
 */
export async function generateImage(
  prompt: string,
  aspectRatio: string = '9:16',
): Promise<GeneratedImage> {
  const client = getClient();
  await ensureOutputDir();

  const imageId = randomUUID();
  const fileName = `${imageId}.png`;
  const localPath = join(GENERATED_ASSETS_DIR, fileName);

  // Enhanced prompt for cinematic vertical video
  const enhancedPrompt = `${prompt}. Ultra high quality, cinematic lighting, photorealistic, vertical format ${aspectRatio}, professional cinematography, sharp focus, vivid colors, 9:16 aspect ratio.`;

  console.log(`[NanoBanana] Gerando imagem: "${prompt.substring(0, 80)}..."`);

  // Model priority: Nano Banana Pro → Imagen 4 Fast → Gemini Flash Image
  const modelConfigs = [
    { name: 'nano-banana-pro-preview', method: 'generateContent' as const },
    { name: 'imagen-4.0-fast-generate-001', method: 'generateImages' as const },
    { name: 'gemini-2.5-flash-image', method: 'generateContent' as const },
  ];

  for (const config of modelConfigs) {
    try {
      console.log(`[NanoBanana] Tentando modelo: ${config.name}`);

      if (config.method === 'generateImages') {
        const response = await client.models.generateImages({
          model: config.name,
          prompt: enhancedPrompt,
          config: { numberOfImages: 1 },
        });

        const images = response.generatedImages;
        if (!images || images.length === 0) {
          throw new Error('Nenhuma imagem retornada.');
        }

        const imageData = images[0].image?.imageBytes;
        if (!imageData) {
          throw new Error('Dados da imagem ausentes.');
        }

        const imageBuffer = Buffer.from(imageData, 'base64');
        await writeFile(localPath, imageBuffer);

        console.log(`[NanoBanana] ✅ Imagem gerada (${config.name}): ${localPath}`);
        return { url: localPath, localPath };

      } else {
        // generateContent method (for Nano Banana Pro and Gemini)
        const response = await client.models.generateContent({
          model: config.name,
          contents: [
            {
              role: 'user',
              parts: [{ text: enhancedPrompt }],
            },
          ],
          config: {
            responseModalities: ['image', 'text'],
          },
        });

        const candidates = response.candidates;
        if (!candidates || candidates.length === 0) {
          throw new Error('Nenhum candidato retornado.');
        }

        const parts = candidates[0].content?.parts;
        if (!parts) throw new Error('Nenhuma parte retornada.');

        const imagePart = parts.find(
          (part) => part.inlineData?.mimeType?.startsWith('image/')
        );

        if (!imagePart?.inlineData?.data) {
          throw new Error('Modelo não retornou dados de imagem.');
        }

        const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
        await writeFile(localPath, imageBuffer);

        console.log(`[NanoBanana] ✅ Imagem gerada (${config.name}): ${localPath}`);
        return { url: localPath, localPath };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[NanoBanana] ⚠️ Modelo ${config.name} falhou: ${msg.substring(0, 150)}`);
    }
  }

  throw new Error(
    `[NanoBanana] Falha na geração de imagem: todos os modelos falharam.`
  );
}
