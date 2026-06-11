/**
 * Etapa 7: Renderização
 * Usa Remotion CLI para renderizar o vídeo final
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ResolvedVideoManifest } from '@video-forge/shared';
import { PipelineLogger } from '../utils/logger';

export interface RenderStepResult {
  outputPath: string;
  durationMs: number;
}

/**
 * Executa a renderização do vídeo com Remotion
 * - Salva o manifest como JSON
 * - Chama `npx remotion render` via CLI
 * - Retorna caminho do MP4 final
 */
export async function executeRender(
  manifest: ResolvedVideoManifest,
  outputDir: string,
  logger: PipelineLogger,
): Promise<RenderStepResult> {
  const startTime = Date.now();

  // Diretórios
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const remotionDir = path.join(projectRoot, 'apps', 'remotion');
  const propsDir = path.join(projectRoot, 'assets', 'temp');

  // Garante que os diretórios existem
  fs.mkdirSync(propsDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Salva o manifest como arquivo de props
  const propsPath = path.join(propsDir, `manifest-${Date.now()}.json`);
  fs.writeFileSync(propsPath, JSON.stringify(manifest, null, 2), 'utf-8');

  logger.info(`Manifest salvo em: ${propsPath}`);

  // Nome do arquivo de saída
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputFileName = `video-${timestamp}.mp4`;
  const outputPath = path.join(outputDir, outputFileName);

  logger.info(`Renderizando vídeo ${manifest.meta.width}x${manifest.meta.height} @ ${manifest.meta.fps}fps...`);
  logger.info(`Total: ${manifest.totalDurationInFrames} frames (${(manifest.totalDurationInFrames / manifest.meta.fps).toFixed(1)}s)`);

  try {
    const remotionBin = path.join(remotionDir, 'node_modules', '.bin', 'remotion');

    logger.info(`Executando: ${remotionBin} render ...`);

    execFileSync(remotionBin, [
      'render',
      'src/Root.tsx',
      'VideoComposition',
      outputPath,
      `--props=${propsPath}`,
      '--codec=h264',
      '--concurrency=50%',
      '--log=verbose',
    ], {
      cwd: remotionDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        PATH: `${path.join(remotionDir, 'node_modules', '.bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
      timeout: 10 * 60 * 1000,
    });

    const durationMs = Date.now() - startTime;

    // Verifica se o arquivo foi criado
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Arquivo de saída não encontrado: ${outputPath}`);
    }

    const stats = fs.statSync(outputPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);

    logger.success(`Vídeo renderizado: ${outputPath} (${sizeMB}MB)`);

    // Limpa arquivo de props temporário
    try {
      fs.unlinkSync(propsPath);
    } catch {
      // Ignora erro de limpeza
    }

    return { outputPath, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error(`Falha na renderização após ${(durationMs / 1000).toFixed(1)}s`, error);
    throw error;
  }
}
