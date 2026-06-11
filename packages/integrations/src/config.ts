// ============================================================
// @video-forge/integrations — Configuração e variáveis de ambiente
// ============================================================
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { existsSync } from 'fs';

/**
 * Encontra a raiz do monorepo subindo diretórios até achar pnpm-workspace.yaml
 */
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume cwd
  return process.cwd();
}

/** Diretório raiz do projeto */
export const PROJECT_ROOT = findProjectRoot();

// Carrega .env da raiz do monorepo
config({ path: join(PROJECT_ROOT, '.env') });

/**
 * Recupera uma variável de ambiente obrigatória.
 * @param key - Nome da variável de ambiente
 * @returns Valor da variável
 * @throws Error se a variável não estiver definida
 */
export function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[VideoForge] Variável de ambiente "${key}" não está definida. ` +
      `Verifique seu arquivo .env na raiz do projeto.`
    );
  }
  return value;
}

/**
 * Recupera uma variável de ambiente opcional.
 * @param key - Nome da variável de ambiente
 * @param defaultValue - Valor padrão caso não esteja definida
 * @returns Valor da variável ou o valor padrão
 */
export function getEnvOptional(key: string, defaultValue = ''): string {
  return process.env[key] ?? defaultValue;
}

/** Diretório para assets gerados por IA */
export const GENERATED_ASSETS_DIR = join(PROJECT_ROOT, 'assets', 'generated');

/** Diretório para assets baixados (stock) */
export const DOWNLOADED_ASSETS_DIR = join(PROJECT_ROOT, 'assets', 'downloaded');

/** Diretório para músicas baixadas */
export const MUSIC_ASSETS_DIR = join(PROJECT_ROOT, 'assets', 'downloaded', 'music');

