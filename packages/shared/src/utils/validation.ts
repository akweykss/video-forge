import { ZodError } from 'zod';
import { VideoManifestSchema, type VideoManifest } from '../schemas/video-manifest';

/**
 * Valida um VideoManifest e retorna erros formatados
 */
export function validateManifest(data: unknown): {
  success: boolean;
  data?: VideoManifest;
  errors?: string[];
} {
  try {
    const parsed = VideoManifestSchema.parse(data);
    return { success: true, data: parsed };
  } catch (error) {
    if (error instanceof ZodError) {
      const errors = error.errors.map(
        (e) => `[${e.path.join('.')}] ${e.message}`,
      );
      return { success: false, errors };
    }
    return { success: false, errors: ['Erro de validação desconhecido'] };
  }
}

/**
 * Valida que a duração total das cenas está dentro do limite
 */
export function validateDuration(
  manifest: VideoManifest,
  maxSeconds: number = 120,
): { valid: boolean; totalSeconds: number; message?: string } {
  const totalSeconds = manifest.scenes.reduce(
    (sum, scene) => sum + scene.durationInSeconds,
    0,
  );

  if (totalSeconds > maxSeconds) {
    return {
      valid: false,
      totalSeconds,
      message: `Duração total (${totalSeconds}s) excede o limite de ${maxSeconds}s`,
    };
  }

  return { valid: true, totalSeconds };
}

/**
 * Valida que todas as cenas com visualType 'ai_image' têm imagePrompt
 */
export function validateAssetRequirements(manifest: VideoManifest): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  for (const scene of manifest.scenes) {
    if (scene.visualType === 'ai_image' && !scene.imagePrompt) {
      issues.push(
        `Cena "${scene.id}": tipo "ai_image" precisa de imagePrompt`,
      );
    }
    if (
      (scene.visualType === 'stock_video' || scene.visualType === 'stock_image') &&
      !scene.stockQuery
    ) {
      issues.push(
        `Cena "${scene.id}": tipo "${scene.visualType}" precisa de stockQuery`,
      );
    }
  }

  return { valid: issues.length === 0, issues };
}
