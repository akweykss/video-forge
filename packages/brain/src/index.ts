/**
 * 🧠 @video-forge/brain
 * Orquestrador central do VideoForge
 */

export { generateVideoFromAudio, type GenerateOptions } from './pipeline/audio-pipeline';
export { PipelineLogger, createProgressTracker, updateProgress } from './utils/logger';
