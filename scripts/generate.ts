#!/usr/bin/env tsx
/**
 * 🎬 VideoForge CLI — Gerador de Vídeos a partir de Áudio
 *
 * Uso:
 *   pnpm generate <caminho-do-audio> [opções]
 *
 * Exemplos:
 *   pnpm generate ./meu-audio.mp3
 *   pnpm generate ./audio.wav --skip-validation
 *   pnpm generate ./narração.m4a --skip-render
 *   pnpm generate ./audio.mp3 --output ./meus-videos
 */

import * as path from 'path';
import { config } from 'dotenv';

// Carrega variáveis de ambiente
config({ path: path.resolve(__dirname, '..', '.env') });

import { generateVideoFromAudio } from '@video-forge/brain';

async function main() {
  const args = process.argv.slice(2);

  // Verifica se tem argumento de áudio
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
🧠 VideoForge — Gerador Automático de Vídeos

Uso:
  pnpm generate <caminho-do-audio> [opções]

Opções:
  --skip-validation    Pula a validação visual (mais rápido, mais barato)
  --skip-render        Pula a renderização (gera apenas o manifest JSON)
  --output <dir>       Diretório de saída (padrão: assets/output/)
  --help, -h           Mostra esta ajuda

Exemplos:
  pnpm generate ./audio/meu-audio.mp3
  pnpm generate ./audio.wav --skip-validation
  pnpm generate ./narração.m4a --skip-render
  pnpm generate ./audio.mp3 --output ./meus-videos

APIs necessárias (configure no .env):
  ASSEMBLYAI_API_KEY     Transcrição de áudio
  ANTHROPIC_API_KEY      Análise + Planejamento (Claude)
  GOOGLE_AI_API_KEY      Imagens IA (Nano Banana Pro)
  PEXELS_API_KEY         B-rolls stock
  PIXABAY_API_KEY        Imagens stock
    `);
    process.exit(0);
  }

  // Parse argumentos
  const audioPath = path.resolve(args[0]);
  const skipValidation = args.includes('--skip-validation');
  const skipRender = args.includes('--skip-render');
  const outputIndex = args.indexOf('--output');
  const outputDir = outputIndex !== -1 ? path.resolve(args[outputIndex + 1]) : undefined;

  // Verifica APIs configuradas
  const requiredEnvVars = [
    'ASSEMBLYAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_AI_API_KEY',
    'PEXELS_API_KEY',
  ];

  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`\n❌ Variáveis de ambiente faltando:`);
    missing.forEach((key) => console.error(`   - ${key}`));
    console.error(`\n💡 Copie .env.example para .env e configure suas chaves de API.\n`);
    process.exit(1);
  }

  try {
    const result = await generateVideoFromAudio(audioPath, {
      outputDir,
      skipValidation,
      skipRender,
    });

    console.log(`\n✅ Resultado: ${result}\n`);
  } catch (error) {
    console.error(`\n❌ Erro fatal:`, error);
    process.exit(1);
  }
}

main();
