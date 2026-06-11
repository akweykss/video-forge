// ============================================================
// @video-forge/integrations — Ponto de Entrada Principal
// ============================================================

// --- Configuração ---
export {
  getEnvOrThrow,
  getEnvOptional,
  PROJECT_ROOT,
  GENERATED_ASSETS_DIR,
  DOWNLOADED_ASSETS_DIR,
  MUSIC_ASSETS_DIR,
} from './config';

// --- AssemblyAI (Transcrição) ---
export {
  transcribeAudio,
  type TranscriptionResult,
} from './assemblyai/client';

// --- Claude / Anthropic (Análise + Planejamento + Validação) ---
export {
  analyzeContent,
  planScenes,
  validateImage,
  CONTENT_ANALYZER_SYSTEM_PROMPT,
  SCENE_PLANNER_SYSTEM_PROMPT,
  IMAGE_PROMPTER_SYSTEM_PROMPT,
  QUALITY_VALIDATOR_SYSTEM_PROMPT,
  type Word,
  type ContentAnalysis,
  type Topic,
  type KeyMoment,
  type Statistic,
  type Quote,
} from './claude/client';

export type { ImageValidation } from './claude/prompts/quality-validator';

// --- Nano Banana Pro / Google GenAI (Geração de Imagens) ---
export {
  generateImage,
  type GeneratedImage,
} from './nanobananana/client';

// --- Stock (Pexels + Pixabay) ---
export {
  searchPexelsVideos,
  searchPexelsPhotos,
  downloadPexelsAsset,
  searchPixabayVideos,
  searchPixabayPhotos,
  searchPixabayMusic,
  downloadPixabayAsset,
  findBRoll,
  findImage,
  type StockVideo,
  type StockPhoto,
  type PixabayStockVideo,
  type PixabayStockPhoto,
  type MusicTrack,
  type UnifiedStockVideo,
  type UnifiedStockPhoto,
} from './stock';

// --- Música ---
export { selectMusic } from './music/selector';
