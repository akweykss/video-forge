// ============================================================
// @video-forge/web — Pipeline Runner
// Executa cada etapa do pipeline e emite eventos de progresso
// ============================================================

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  transcribeAudio,
  analyzeContent,
  planScenes,
  generateImage,
  validateImage,
  findBRoll,
  findImage,
  selectMusic,
  type TranscriptionResult,
  type ContentAnalysis,
  type GeneratedImage,
} from '@video-forge/integrations';
import {
  validateManifest,
  validateDuration,
  validateAssetRequirements,
  secondsToFrames,
  formatDuration,
  type VideoManifest,
  type ResolvedVideoManifest,
  type ResolvedScene,
} from '@video-forge/shared';

// ============================================================
// Types
// ============================================================

export interface PipelineEvent {
  step: number;
  totalSteps: number;
  stepName: string;
  progress: number;
  status: 'running' | 'done' | 'error' | 'skipped';
  message?: string;
  data?: unknown;
}

export interface PipelineOptions {
  skipValidation?: boolean;
  skipRender?: boolean;
}

export interface GeneratedAsset {
  sceneId: string;
  localPath: string;
  type: 'image' | 'video';
  source: 'ai' | 'stock';
}

type ProgressCallback = (event: PipelineEvent) => void;

const TOTAL_STEPS = 7;

const STEP_NAMES = [
  'Transcrição',
  'Análise',
  'Planejamento',
  'Assets',
  'Validação',
  'Sincronização',
  'Renderização',
];

// ============================================================
// Helper — emit progress
// ============================================================

function emit(
  cb: ProgressCallback,
  step: number,
  status: PipelineEvent['status'],
  progress: number,
  message?: string,
  data?: unknown,
) {
  cb({
    step,
    totalSteps: TOTAL_STEPS,
    stepName: STEP_NAMES[step - 1],
    progress: Math.round(progress),
    status,
    message,
    data,
  });
}

// ============================================================
// Main pipeline
// ============================================================

export async function runPipeline(
  audioPath: string,
  options: PipelineOptions,
  onProgress: ProgressCallback,
): Promise<{ outputPath: string; manifest: ResolvedVideoManifest }> {
  const projectRoot = path.resolve(__dirname, '..', '..', '..');

  // ============================================================
  // STEP 1 — Transcrição
  // ============================================================
  emit(onProgress, 1, 'running', 5, 'Enviando áudio para transcrição...');

  let transcription: TranscriptionResult;
  try {
    transcription = await transcribeAudio(audioPath);
    const durationSec = Math.round(transcription.durationMs / 1000);
    emit(onProgress, 1, 'done', 14, `Transcrição concluída: ${transcription.words.length} palavras, ${durationSec}s`, {
      text: transcription.text,
      wordCount: transcription.words.length,
      durationMs: transcription.durationMs,
    });
  } catch (err) {
    emit(onProgress, 1, 'error', 14, `Falha na transcrição: ${(err as Error).message}`);
    throw err;
  }

  // ============================================================
  // STEP 2 — Análise de Conteúdo
  // ============================================================
  emit(onProgress, 2, 'running', 16, 'Analisando conteúdo com Claude...');

  let analysis: ContentAnalysis;
  try {
    analysis = await analyzeContent(transcription.text, transcription.words);
    emit(onProgress, 2, 'done', 28, `Análise concluída: ${analysis.topics.length} tópicos, mood: ${analysis.emotionalTone.suggestedMood}`, {
      topicCount: analysis.topics.length,
      keyMomentCount: analysis.keyMoments.length,
      mood: analysis.emotionalTone.suggestedMood,
      summary: analysis.summary,
    });
  } catch (err) {
    emit(onProgress, 2, 'error', 28, `Falha na análise: ${(err as Error).message}`);
    throw err;
  }

  // ============================================================
  // STEP 3 — Planejamento de Cenas
  // ============================================================
  emit(onProgress, 3, 'running', 30, 'Planejando cenas com Claude...');

  let manifest: VideoManifest;
  try {
    const audioDurationSeconds = Math.round(transcription.durationMs / 1000);
    manifest = await planScenes(analysis, audioDurationSeconds, transcription.words);

    // Validate manifest
    const validation = validateManifest(manifest);
    if (!validation.success) {
      console.warn('[Pipeline] Manifest com avisos de validação:', validation.errors);
    }

    const durationCheck = validateDuration(manifest);
    const assetCheck = validateAssetRequirements(manifest);

    emit(onProgress, 3, 'done', 38, `Planejamento concluído: ${manifest.scenes.length} cenas, mood: ${manifest.style.mood}`, {
      sceneCount: manifest.scenes.length,
      scenes: manifest.scenes.map((s) => ({
        id: s.id,
        type: s.type,
        visualType: s.visualType,
        durationInSeconds: s.durationInSeconds,
        headline: s.headline,
        animation: s.animation,
        transition: s.transition,
        narrationStartMs: s.narrationStartMs,
        narrationEndMs: s.narrationEndMs,
      })),
      totalDuration: durationCheck.totalSeconds,
      assetIssues: assetCheck.issues,
    });
  } catch (err) {
    emit(onProgress, 3, 'error', 38, `Falha no planejamento: ${(err as Error).message}`);
    throw err;
  }

  // ============================================================
  // STEP 4 — Geração de Assets
  // ============================================================
  emit(onProgress, 4, 'running', 40, 'Gerando/buscando assets visuais...');

  const assets: GeneratedAsset[] = [];
  const scenesToProcess = manifest.scenes.filter(
    (s) => s.visualType !== 'text_card' && s.visualType !== 'animation_only',
  );
  const totalAssets = scenesToProcess.length;

  // Also try to select background music
  let musicPath: string | undefined;
  try {
    emit(onProgress, 4, 'running', 41, 'Selecionando música de fundo...');
    const music = await selectMusic(manifest.style.mood);
    musicPath = music.localPath;
    emit(onProgress, 4, 'running', 43, `Música selecionada: "${music.title}"`);
  } catch (err) {
    console.warn('[Pipeline] Falha ao selecionar música, continuando sem:', (err as Error).message);
    emit(onProgress, 4, 'running', 43, 'Música de fundo indisponível, continuando...');
  }

  // Generate assets with concurrency control
  const CONCURRENCY = 3;
  for (let i = 0; i < scenesToProcess.length; i += CONCURRENCY) {
    const batch = scenesToProcess.slice(i, i + CONCURRENCY);
    const progressBase = 43 + ((i / totalAssets) * 20);

    const results = await Promise.allSettled(
      batch.map(async (scene) => {
        try {
          switch (scene.visualType) {
            case 'ai_image': {
              if (!scene.imagePrompt) return null;
              const result = await generateImage(scene.imagePrompt, '9:16');
              return {
                sceneId: scene.id,
                localPath: result.localPath,
                type: 'image' as const,
                source: 'ai' as const,
              };
            }
            case 'stock_video': {
              if (!scene.stockQuery) return null;
              const video = await findBRoll(scene.stockQuery);
              return {
                sceneId: scene.id,
                localPath: video.localPath || '',
                type: 'video' as const,
                source: 'stock' as const,
              };
            }
            case 'stock_image': {
              if (!scene.stockQuery) return null;
              const photo = await findImage(scene.stockQuery);
              return {
                sceneId: scene.id,
                localPath: photo.localPath || '',
                type: 'image' as const,
                source: 'stock' as const,
              };
            }
            default:
              return null;
          }
        } catch (err) {
          console.error(`[Pipeline] Falha ao gerar asset para cena ${scene.id}:`, err);
          return null;
        }
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        assets.push(result.value);
      }
    }

    const processedSoFar = Math.min(i + CONCURRENCY, totalAssets);
    emit(
      onProgress, 4, 'running',
      progressBase + 4,
      `Assets: ${processedSoFar}/${totalAssets} processados (${assets.length} gerados)`,
    );
  }

  const aiCount = assets.filter((a) => a.source === 'ai').length;
  const stockCount = assets.filter((a) => a.source === 'stock').length;
  emit(onProgress, 4, 'done', 64, `Assets concluídos: ${assets.length} total (${aiCount} IA, ${stockCount} stock)`, {
    totalAssets: assets.length,
    aiGenerated: aiCount,
    stockDownloaded: stockCount,
    assetPaths: assets.map((a) => ({
      sceneId: a.sceneId,
      path: a.localPath,
      type: a.type,
      source: a.source,
    })),
  });

  // ============================================================
  // STEP 5 — Validação Visual
  // ============================================================
  let validAssets = assets;

  if (options.skipValidation) {
    emit(onProgress, 5, 'skipped', 72, 'Validação visual pulada (opção selecionada)');
  } else {
    emit(onProgress, 5, 'running', 66, 'Validando qualidade visual com Claude Vision...');

    const validatedAssets: GeneratedAsset[] = [];
    let validated = 0;

    for (const asset of assets) {
      const scene = manifest.scenes.find((s) => s.id === asset.sceneId);
      const description = scene?.stockQuery || scene?.imagePrompt || scene?.headline || '';

      try {
        const result = await validateImage(asset.localPath, description);
        validated++;
        const pct = 66 + ((validated / assets.length) * 6);
        if (result.pass) {
          validatedAssets.push(asset);
          emit(onProgress, 5, 'running', pct, `${asset.sceneId} (${asset.source}): Score ${result.averageScore.toFixed(1)} ✓`);
        } else {
          emit(onProgress, 5, 'running', pct, `${asset.sceneId} (${asset.source}): Score ${result.averageScore.toFixed(1)} — Tentando melhorar...`);
          // For AI images: regenerate with improved prompt
          if (asset.source === 'ai' && scene?.imagePrompt) {
            try {
              const improved = `${scene.imagePrompt}. IMPORTANT: Avoid: ${result.issues.join('. ')}. High quality, 4K.`;
              const newImg = await generateImage(improved, '9:16');
              validatedAssets.push({ ...asset, localPath: newImg.localPath });
            } catch {
              validatedAssets.push(asset); // keep original
            }
          } else {
            // For stock/TMDB: accept anyway (finding another stock takes too long)
            validatedAssets.push(asset);
          }
        }
      } catch (err) {
        console.warn(`[Pipeline] Validação falhou para ${asset.sceneId}, aceitando:`, err);
        validatedAssets.push(asset);
      }
    }

    validAssets = validatedAssets;
    emit(onProgress, 5, 'done', 72, `Validação concluída: ${validAssets.length} assets aprovados`, {
      validatedCount: validAssets.length,
    });
  }

  // ============================================================
  // STEP 6 — Sincronização de Timing (Posicionamento Absoluto)
  // ============================================================
  emit(onProgress, 6, 'running', 74, 'Sincronizando timing com áudio...');

  let resolvedManifest: ResolvedVideoManifest;
  try {
    const fps = manifest.meta.fps;
    const audioDurationMs = transcription.durationMs;
    const totalAudioFrames = secondsToFrames(audioDurationMs / 1000, fps);
    const assetMap = new Map(validAssets.map((a) => [a.sceneId, a]));
    const words = transcription.words;

    // Helper: find word timestamps by matching narration text
    function findWordTimestamps(narrationText: string): { startMs: number; endMs: number } | null {
      if (!narrationText || words.length === 0) return null;

      const searchWords = narrationText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (searchWords.length === 0) return null;

      // Find first matching word
      const firstWord = searchWords[0];
      let bestStart = -1;
      let bestEnd = -1;

      for (let i = 0; i < words.length; i++) {
        if (words[i].text.toLowerCase().includes(firstWord)) {
          bestStart = words[i].start;
          // Find last matching word from this position
          for (let j = Math.min(i + searchWords.length + 5, words.length - 1); j >= i; j--) {
            const lastWord = searchWords[searchWords.length - 1];
            if (words[j].text.toLowerCase().includes(lastWord)) {
              bestEnd = words[j].end;
              break;
            }
          }
          if (bestEnd > bestStart) break;
        }
      }

      if (bestStart >= 0 && bestEnd > bestStart) {
        return { startMs: bestStart, endMs: bestEnd };
      }
      return null;
    }

    // Process scenes with absolute positioning
    const resolvedScenes: ResolvedScene[] = [];
    let lastEndMs = 0;

    for (const scene of manifest.scenes) {
      let startMs = scene.narrationStartMs ?? undefined;
      let endMs = scene.narrationEndMs ?? undefined;

      // If Claude didn't provide timestamps, try to match from narrationText
      if ((startMs === undefined || endMs === undefined) && scene.narrationText) {
        const matched = findWordTimestamps(scene.narrationText);
        if (matched) {
          startMs = matched.startMs;
          endMs = matched.endMs;
          console.log(`[Sync] Matched "${scene.narrationText?.substring(0, 40)}..." → ${startMs}ms-${endMs}ms`);
        }
      }

      // Fallback: use sequential positioning
      if (startMs === undefined || endMs === undefined) {
        startMs = lastEndMs;
        endMs = startMs + (scene.durationInSeconds * 1000);
        console.log(`[Sync] Fallback for ${scene.id}: ${startMs}ms-${endMs}ms`);
      }

      // Ensure minimum duration of 2 seconds
      const durationMs = Math.max(endMs - startMs, 2000);
      const durationInSeconds = Math.ceil(durationMs / 1000);
      const durationInFrames = secondsToFrames(durationInSeconds, fps);
      const startFrame = Math.round((startMs / 1000) * fps);

      const asset = assetMap.get(scene.id);
      const assetUrl = asset?.localPath || scene.assetUrl || '';

      resolvedScenes.push({
        ...scene,
        assetUrl,
        durationInFrames,
        startFrame,
        narrationStartMs: startMs,
        narrationEndMs: endMs,
      });

      lastEndMs = endMs;

      console.log(
        `[Sync] ${scene.id}: frame ${startFrame} (${(startMs / 1000).toFixed(1)}s) → ${durationInFrames} frames (${durationInSeconds}s) | ${scene.headline || scene.type}`
      );
    }

    // Sort by startFrame to ensure correct order
    resolvedScenes.sort((a, b) => a.startFrame - b.startFrame);

    // Total duration = audio duration (so audio and video end together)
    const totalDurationInFrames = Math.max(
      totalAudioFrames,
      ...resolvedScenes.map(s => s.startFrame + s.durationInFrames)
    );

    resolvedManifest = {
      ...manifest,
      scenes: resolvedScenes,
      totalDurationInFrames,
      localAudioPath: audioPath,
      localMusicPath: musicPath,
      // Word-level timestamps for synchronized captions
      words: transcription.words.map(w => ({
        text: w.text,
        start: w.start,
        end: w.end,
      })),
    };

    const totalSeconds = totalDurationInFrames / fps;
    emit(onProgress, 6, 'done', 82, `Timing sincronizado: ${resolvedScenes.length} cenas, ${totalDurationInFrames} frames (${totalSeconds.toFixed(1)}s)`, {
      totalDurationInFrames,
      totalSeconds,
      sceneTimings: resolvedScenes.map((s) => ({
        id: s.id,
        type: s.type,
        startFrame: s.startFrame,
        durationInFrames: s.durationInFrames,
        hasAsset: !!s.assetUrl,
        narrationStartMs: s.narrationStartMs,
        narrationEndMs: s.narrationEndMs,
      })),
    });
  } catch (err) {
    emit(onProgress, 6, 'error', 82, `Falha na sincronização: ${(err as Error).message}`);
    throw err;
  }

  // ============================================================
  // STEP 6.5 — Revisão Final de Contexto (Claude Vision)
  // Verifica se TODAS as imagens fazem sentido com a narração
  // ============================================================
  if (!options.skipValidation) {
    emit(onProgress, 6, 'running', 83, '🔍 Revisão final: verificando contexto de cada cena...');

    let replacedCount = 0;
    const totalScenes = resolvedManifest.scenes.length;

    for (let i = 0; i < resolvedManifest.scenes.length; i++) {
      const scene = resolvedManifest.scenes[i];
      const asset = validAssets.find(a => a.sceneId === scene.id);

      if (!asset?.localPath || !fs.existsSync(asset.localPath)) continue;

      const narrationContext = scene.narrationText || scene.headline || '';
      const pct = 83 + ((i / totalScenes) * 7);

      try {
        const result = await validateImage(asset.localPath, narrationContext);

        if (result.averageScore < 2.5 || (result.scores.relevance && result.scores.relevance < 2)) {
          // Image is OUT OF CONTEXT — try to replace
          emit(onProgress, 6, 'running', pct,
            `⚠️ ${scene.id}: imagem fora de contexto (relevância: ${result.scores.relevance}/5) — buscando substituta...`
          );

          const searchQuery = scene.stockQuery || narrationContext;
          try {
            const replacement = await findImage(searchQuery);
            if (replacement.localPath) {
              // Update the asset
              asset.localPath = replacement.localPath;
              // Update resolved scene
              scene.assetUrl = replacement.localPath;
              replacedCount++;
              emit(onProgress, 6, 'running', pct,
                `✅ ${scene.id}: substituída com sucesso!`
              );
            }
          } catch (replaceErr) {
            console.warn(`[Pipeline] Não conseguiu substituir ${scene.id}:`, replaceErr);
            // Keep original
          }
        } else {
          emit(onProgress, 6, 'running', pct,
            `✓ ${scene.id}: contexto OK (${result.averageScore.toFixed(1)}/5)`
          );
        }
      } catch (err) {
        console.warn(`[Pipeline] Revisão falhou para ${scene.id}:`, err);
        // Skip this scene — don't block rendering
      }
    }

    const reviewMsg = replacedCount > 0
      ? `Revisão final: ${replacedCount} imagens substituídas por melhor contexto`
      : 'Revisão final: todas as imagens aprovadas ✅';
    emit(onProgress, 6, 'done', 90, reviewMsg);
  }

  // ============================================================
  // STEP 7 — Renderização
  // ============================================================
  const outputDir = path.join(projectRoot, 'assets', 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  if (options.skipRender) {
    // Save manifest only
    const manifestPath = path.join(outputDir, `manifest-${Date.now()}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(resolvedManifest, null, 2), 'utf-8');
    emit(onProgress, 7, 'skipped', 100, `Renderização pulada. Manifest salvo.`, {
      manifestPath,
    });
    return { outputPath: manifestPath, manifest: resolvedManifest };
  }

  emit(onProgress, 7, 'running', 84, 'Preparando renderização com Remotion...');

  try {
    const remotionDir = path.join(projectRoot, 'apps', 'remotion');
    const pipelineAssetsDir = path.join(remotionDir, 'public', 'pipeline-assets');
    const propsDir = path.join(projectRoot, 'assets', 'temp');

    // Clean previous pipeline assets and recreate
    if (fs.existsSync(pipelineAssetsDir)) {
      fs.rmSync(pipelineAssetsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(pipelineAssetsDir, { recursive: true });
    fs.mkdirSync(propsDir, { recursive: true });

    emit(onProgress, 7, 'running', 86, 'Copiando assets para Remotion...');

    // Helper: copy file to pipeline-assets and return the staticFile-compatible path
    const copyAsset = (sourcePath: string, name: string): string => {
      if (!sourcePath || !fs.existsSync(sourcePath)) return '';
      const ext = path.extname(sourcePath);
      const destName = `${name}${ext}`;
      const destPath = path.join(pipelineAssetsDir, destName);
      fs.copyFileSync(sourcePath, destPath);
      return `pipeline-assets/${destName}`;
    };

    // Copy audio
    let audioStaticPath = '';
    if (resolvedManifest.localAudioPath && fs.existsSync(resolvedManifest.localAudioPath)) {
      audioStaticPath = copyAsset(resolvedManifest.localAudioPath, 'narration');
    }

    // Copy music
    let musicStaticPath = '';
    if (resolvedManifest.localMusicPath && fs.existsSync(resolvedManifest.localMusicPath)) {
      musicStaticPath = copyAsset(resolvedManifest.localMusicPath, 'music');
    }

    // Copy scene assets
    const updatedScenes = resolvedManifest.scenes.map((scene, i) => {
      if (scene.assetUrl && fs.existsSync(scene.assetUrl)) {
        const staticPath = copyAsset(scene.assetUrl, `scene-${String(i).padStart(3, '0')}`);
        return { ...scene, assetUrl: staticPath };
      }
      return scene;
    });

    // Build the render-ready manifest with staticFile paths
    const renderManifest = {
      ...resolvedManifest,
      scenes: updatedScenes,
      localAudioPath: audioStaticPath || undefined,
      localMusicPath: musicStaticPath || undefined,
    };

    const propsPath = path.join(propsDir, `manifest-${Date.now()}.json`);
    fs.writeFileSync(propsPath, JSON.stringify(renderManifest, null, 2), 'utf-8');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputFileName = `video-${timestamp}.mp4`;
    const outputPath = path.join(outputDir, outputFileName);

    emit(onProgress, 7, 'running', 88, `Renderizando ${resolvedManifest.meta.width}x${resolvedManifest.meta.height} @ ${resolvedManifest.meta.fps}fps...`);

    const remotionBin = path.join(remotionDir, 'node_modules', '.bin', 'remotion');

    execFileSync(remotionBin, [
      'render',
      'src/Root.tsx',
      'VideoComposition',
      outputPath,
      `--props=${propsPath}`,
      '--codec=h264',
      '--concurrency=50%',
      '--log=info',
    ], {
      cwd: remotionDir,
      stdio: 'pipe',
      maxBuffer: 100 * 1024 * 1024, // 100MB buffer to prevent ENOBUFS
      env: {
        ...process.env,
        PATH: `${path.join(remotionDir, 'node_modules', '.bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
      timeout: 10 * 60 * 1000,
    });

    // Cleanup
    try { fs.unlinkSync(propsPath); } catch { /* ignore */ }
    try { fs.rmSync(pipelineAssetsDir, { recursive: true, force: true }); } catch { /* ignore */ }

    if (!fs.existsSync(outputPath)) {
      throw new Error(`Arquivo de saída não encontrado: ${outputPath}`);
    }

    const stats = fs.statSync(outputPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);

    emit(onProgress, 7, 'done', 100, `Vídeo renderizado com sucesso! (${sizeMB}MB)`, {
      outputPath,
      sizeMB: parseFloat(sizeMB),
      fileName: outputFileName,
    });

    return { outputPath, manifest: resolvedManifest };
  } catch (err) {
    emit(onProgress, 7, 'error', 95, `Falha na renderização: ${(err as Error).message}`);
    throw err;
  }
}
