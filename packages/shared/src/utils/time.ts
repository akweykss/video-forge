/**
 * Utilitários de conversão entre tempo e frames para Remotion
 */

/** Converte segundos para frames */
export function secondsToFrames(seconds: number, fps: number = 30): number {
  return Math.round(seconds * fps);
}

/** Converte frames para segundos */
export function framesToSeconds(frames: number, fps: number = 30): number {
  return frames / fps;
}

/** Converte milissegundos para frames */
export function msToFrames(ms: number, fps: number = 30): number {
  return Math.round((ms / 1000) * fps);
}

/** Converte frames para milissegundos */
export function framesToMs(frames: number, fps: number = 30): number {
  return Math.round((frames / fps) * 1000);
}

/** Formata duração em segundos para mm:ss */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Calcula duração total em frames a partir de um array de cenas */
export function calculateTotalFrames(
  scenes: Array<{ durationInSeconds: number }>,
  fps: number = 30,
): number {
  return scenes.reduce(
    (total, scene) => total + secondsToFrames(scene.durationInSeconds, fps),
    0,
  );
}

/** Gera um ID único para cena baseado no index */
export function generateSceneId(index: number): string {
  return `scene-${String(index + 1).padStart(2, '0')}`;
}
