// ============================================================
// @video-forge/shared — Tipos, Schemas e Utilitários
// ============================================================

// --- Schemas ---
export {
  AnimationType,
  TransitionType,
  VisualType,
  SceneType,
  VideoMood,
} from './schemas/scene-types';

export {
  SceneSchema,
  VideoManifestSchema,
  ResolvedSceneSchema,
  ResolvedVideoManifestSchema,
  type Scene,
  type VideoManifest,
  type ResolvedScene,
  type ResolvedVideoManifest,
} from './schemas/video-manifest';

export {
  JobStatus,
  InputType,
  VideoJobSchema,
  type VideoJob,
} from './schemas/job';

// --- Utils ---
export {
  secondsToFrames,
  framesToSeconds,
  msToFrames,
  framesToMs,
  formatDuration,
  calculateTotalFrames,
  generateSceneId,
} from './utils/time';

export {
  validateManifest,
  validateDuration,
  validateAssetRequirements,
} from './utils/validation';
