import { v4 as uuidv4 } from 'uuid';
import type { VideoJob } from '@video-forge/shared';

/**
 * Logger simples para o pipeline
 * Exibe mensagens formatadas com timestamp e nível
 */
export class PipelineLogger {
  private jobId: string;

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  private format(level: string, emoji: string, message: string): string {
    const time = new Date().toLocaleTimeString('pt-BR');
    return `${emoji} [${time}] [${level}] [${this.jobId.slice(0, 8)}] ${message}`;
  }

  info(message: string): void {
    console.log(this.format('INFO', '📋', message));
  }

  success(message: string): void {
    console.log(this.format('OK', '✅', message));
  }

  warn(message: string): void {
    console.warn(this.format('WARN', '⚠️', message));
  }

  error(message: string, error?: unknown): void {
    console.error(this.format('ERROR', '❌', message));
    if (error instanceof Error) {
      console.error(`   └─ ${error.message}`);
    }
  }

  step(stepNumber: number, totalSteps: number, name: string): void {
    const progress = Math.round((stepNumber / totalSteps) * 100);
    console.log(
      this.format('STEP', '🔄', `[${stepNumber}/${totalSteps}] (${progress}%) ${name}`),
    );
  }

  done(outputPath: string, durationMs: number): void {
    const seconds = (durationMs / 1000).toFixed(1);
    console.log('\n' + '═'.repeat(60));
    console.log(this.format('DONE', '🎬', `Vídeo gerado com sucesso!`));
    console.log(`   📁 Arquivo: ${outputPath}`);
    console.log(`   ⏱️  Tempo total: ${seconds}s`);
    console.log('═'.repeat(60) + '\n');
  }
}

/**
 * Rastreador de progresso do pipeline
 */
export interface ProgressTracker {
  jobId: string;
  status: VideoJob['status'];
  progress: number;
  currentStep: string;
  startedAt: Date;
  error?: string;
}

export function createProgressTracker(inputPath: string): ProgressTracker {
  return {
    jobId: uuidv4(),
    status: 'idle',
    progress: 0,
    currentStep: 'Inicializando',
    startedAt: new Date(),
  };
}

export function updateProgress(
  tracker: ProgressTracker,
  status: VideoJob['status'],
  progress: number,
  currentStep: string,
): void {
  tracker.status = status;
  tracker.progress = progress;
  tracker.currentStep = currentStep;
}
