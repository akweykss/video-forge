// ============================================================
// @video-forge/web — Express Server
// Upload, SSE progress streaming, and static file serving
// ============================================================

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { config } from 'dotenv';
import { runPipeline, type PipelineEvent, type PipelineOptions } from './pipeline-runner';

// Load .env from project root
config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

// ============================================================
// Constants
// ============================================================

const PORT = parseInt(process.env.PORT || '3333', 10);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const UPLOADS_DIR = path.join(PROJECT_ROOT, 'assets', 'uploads');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Ensure directories exist
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(path.join(ASSETS_DIR, 'generated'), { recursive: true });
fs.mkdirSync(path.join(ASSETS_DIR, 'downloaded'), { recursive: true });
fs.mkdirSync(path.join(ASSETS_DIR, 'output'), { recursive: true });

// ============================================================
// In-memory job store
// ============================================================

interface Job {
  id: string;
  audioPath: string;
  originalFilename: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  options: PipelineOptions;
  events: PipelineEvent[];
  result?: { outputPath: string; manifest: unknown };
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

const jobs = new Map<string, Job>();

// ============================================================
// Multer upload config
// ============================================================

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${uuidv4()}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Formato não suportado: ${ext}. Use: ${allowed.join(', ')}`));
    }
  },
});

// ============================================================
// Express app
// ============================================================

const app = express();
app.use(cors());
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    // Skip JSON body parsing for multipart uploads (e.g. character images)
    // The raw body will be piped directly in the proxy handler
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Static files
app.use(express.static(PUBLIC_DIR));
app.use('/assets', express.static(ASSETS_DIR));

// ============================================================
// Proxy: /api/translate/* → FastAPI (port 8000)
// ============================================================
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8000';

app.all(['/api/translate/*', '/api/tts/*'], async (req, res) => {
  const targetPath = req.originalUrl; // Keep full path
  const targetUrl = `${FASTAPI_URL}${targetPath}`;

  try {
    const headers: Record<string, string> = {
      'Host': new URL(FASTAPI_URL).host,
    };

    // Forward content-type for POST/PUT/PATCH
    if (req.headers['content-type']) {
      headers['Content-Type'] = req.headers['content-type'] as string;
    }

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    // Forward body for non-GET requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const ct = (req.headers['content-type'] || '') as string;
      if (ct.includes('multipart/form-data')) {
        // For multipart uploads, collect raw chunks and forward
        // (req.body is undefined since express.json() skips multipart)
        const rawChunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => rawChunks.push(chunk));
        await new Promise<void>((resolve) => req.on('end', resolve));
        fetchOptions.body = Buffer.concat(rawChunks);
      } else if (req.body) {
        fetchOptions.body = JSON.stringify(req.body);
      }
    }

    const proxyRes = await fetch(targetUrl, fetchOptions);

    // Forward status and headers
    res.status(proxyRes.status);

    // Check if SSE
    const contentType = proxyRes.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Stream SSE data
      const reader = proxyRes.body?.getReader();
      if (reader) {
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(new TextDecoder().decode(value));
          }
          res.end();
        };
        pump().catch(() => res.end());
      }
      return;
    }

    // Check if binary (file download / video / audio / image stream)
    if (contentType.includes('video/') || contentType.includes('audio/') || contentType.includes('image/') || contentType.includes('application/octet-stream')) {
      res.setHeader('Content-Type', contentType);
      const disposition = proxyRes.headers.get('content-disposition');
      if (disposition) res.setHeader('Content-Disposition', disposition);
      const contentLength = proxyRes.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);

      // Stream the response body instead of buffering
      const reader = proxyRes.body?.getReader();
      if (reader) {
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
        };
        pump().catch(() => res.end());
      } else {
        res.status(500).send('No response body');
      }
      return;
    }

    // JSON response
    res.setHeader('Content-Type', contentType || 'application/json');
    const body = await proxyRes.text();
    res.send(body);
  } catch (error) {
    console.error(`[Proxy] Erro ao encaminhar para FastAPI: ${error}`);
    res.status(502).json({
      error: 'Translation Pipeline indisponível',
      detail: 'O servidor FastAPI não está rodando. Inicie com: cd apps/translation-pipeline && python -m uvicorn src.server:app --port 8000',
    });
  }
});

// ============================================================
// GET /api/manifests — List all generated manifests
// ============================================================

app.get('/api/manifests', (_req, res) => {
  const tempDir = path.join(ASSETS_DIR, 'temp');
  try {
    const files = fs.readdirSync(tempDir)
      .filter(f => f.startsWith('manifest-') && f.endsWith('.json'))
      .sort()
      .reverse();

    const manifests = files.map(f => {
      const filePath = path.join(tempDir, f);
      const stat = fs.statSync(filePath);
      let title = f;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        title = data.meta?.title || f;
      } catch { /* ignore */ }
      return { filename: f, title, size: stat.size, modified: stat.mtime };
    });

    res.json(manifests);
  } catch {
    res.json([]);
  }
});

// GET /api/manifest/:filename — Serve a specific manifest
app.get('/api/manifest/:filename', (req, res) => {
  const filePath = path.join(ASSETS_DIR, 'temp', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Manifest not found' });
  }
});

// POST /api/manifest/:filename — Save edited manifest
app.post('/api/manifest/:filename', (req, res) => {
  const filePath = path.join(ASSETS_DIR, 'temp', req.params.filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save manifest' });
  }
});

// GET /api/videos — List rendered video files
app.get('/api/videos', (_req, res) => {
  const outputDir = path.join(ASSETS_DIR, 'output');
  try {
    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.mp4'))
      .sort()
      .reverse();
    const videos = files.map(f => {
      const stat = fs.statSync(path.join(outputDir, f));
      return { filename: f, size: stat.size, modified: stat.mtime, url: `/assets/output/${f}` };
    });
    res.json(videos);
  } catch { res.json([]); }
});
// ============================================================
// POST /api/upload — Upload audio file
// ============================================================

app.post('/api/upload', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo de áudio enviado.' });
      return;
    }

    const jobId = uuidv4();
    const skipValidation = req.body.skipValidation === 'true';
    const skipRender = req.body.skipRender === 'true';

    const job: Job = {
      id: jobId,
      audioPath: req.file.path,
      originalFilename: req.file.originalname,
      status: 'pending',
      options: { skipValidation, skipRender },
      events: [],
      createdAt: Date.now(),
    };

    jobs.set(jobId, job);

    res.json({
      jobId,
      filename: req.file.originalname,
      size: req.file.size,
      message: 'Upload concluído. Inicie a geração em /api/generate/:jobId',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/generate/:jobId — SSE pipeline progress
// ============================================================

app.get('/api/generate/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job não encontrado.' });
    return;
  }

  if (job.status === 'running') {
    res.status(409).json({ error: 'Job já está em execução.' });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial event
  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('connected', { jobId, message: 'Pipeline iniciado' });

  // Update job status
  job.status = 'running';
  job.startedAt = Date.now();

  // Start pipeline
  const onProgress = (event: PipelineEvent) => {
    job.events.push(event);
    sendEvent('progress', event);
  };

  runPipeline(job.audioPath, job.options, onProgress)
    .then((result) => {
      job.status = 'completed';
      job.completedAt = Date.now();
      job.result = result;

      // Make the output path relative so frontend can access it
      const relativePath = path.relative(ASSETS_DIR, result.outputPath);

      sendEvent('complete', {
        outputPath: `/assets/${relativePath}`,
        manifest: result.manifest,
        durationMs: job.completedAt - (job.startedAt || job.createdAt),
      });
      res.end();
    })
    .catch((err) => {
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = (err as Error).message;

      sendEvent('error', {
        message: (err as Error).message,
        durationMs: Date.now() - (job.startedAt || job.createdAt),
      });
      res.end();
    });

  // Handle client disconnect
  req.on('close', () => {
    // Pipeline continues running even if client disconnects
    console.log(`[Server] Cliente desconectou do job ${jobId}`);
  });
});

// ============================================================
// GET /api/status/:jobId — Poll job status
// ============================================================

app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job não encontrado.' });
    return;
  }

  const lastEvent = job.events.length > 0 ? job.events[job.events.length - 1] : null;
  const relativePath = job.result?.outputPath
    ? `/assets/${path.relative(ASSETS_DIR, job.result.outputPath)}`
    : undefined;

  res.json({
    jobId: job.id,
    status: job.status,
    filename: job.originalFilename,
    options: job.options,
    currentStep: lastEvent?.step || 0,
    currentStepName: lastEvent?.stepName || '',
    progress: lastEvent?.progress || 0,
    events: job.events,
    result: job.result ? { outputPath: relativePath, manifest: job.result.manifest } : undefined,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationMs: job.completedAt
      ? job.completedAt - (job.startedAt || job.createdAt)
      : job.startedAt
        ? Date.now() - job.startedAt
        : undefined,
  });
});

// ============================================================
// GET /api/jobs — List all jobs
// ============================================================

app.get('/api/jobs', (_req, res) => {
  const allJobs = Array.from(jobs.values()).map((job) => ({
    id: job.id,
    status: job.status,
    filename: job.originalFilename,
    progress: job.events.length > 0 ? job.events[job.events.length - 1].progress : 0,
    createdAt: job.createdAt,
  }));
  res.json(allJobs);
});

// ============================================================
// Start server
// ============================================================

app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(60));
  console.log('🧠 VideoForge — Web Interface');
  console.log('═'.repeat(60));
  console.log(`🌐 Server:   http://localhost:${PORT}`);
  console.log(`📁 Uploads:  ${UPLOADS_DIR}`);
  console.log(`📁 Assets:   ${ASSETS_DIR}`);
  console.log(`📁 Public:   ${PUBLIC_DIR}`);
  console.log('═'.repeat(60) + '\n');

  // Auto-open browser (only on first start, not on tsx watch restarts)
  const url = `http://localhost:${PORT}`;
  const flagFile = path.join(os.tmpdir(), `videoforge-browser-opened-${PORT}.flag`);
  let isRestart = false;
  if (fs.existsSync(flagFile)) {
    // Expire flag after 6 hours — next dev session opens browser again
    const flagAge = Date.now() - Number(fs.readFileSync(flagFile, 'utf-8') || '0');
    isRestart = flagAge < 6 * 60 * 60 * 1000;
  }

  if (!isRestart) {
    fs.writeFileSync(flagFile, Date.now().toString(), 'utf-8');
    import('child_process').then(({ exec }) => {
      // macOS
      exec(`open "${url}"`, (err) => {
        if (err) {
          // Linux fallback
          exec(`xdg-open "${url}"`, (err2) => {
            if (err2) {
              console.log(`📎 Abra manualmente: ${url}`);
            }
          });
        }
      });
      console.log(`🚀 Abrindo navegador: ${url}`);
    });
  }
});

export default app;
