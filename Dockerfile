# ════════════════════════════════════════════════════════════════
# Fold Videos — site (Express) + motor (FastAPI + FFmpeg)
# Um único container: o Express serve a UI e faz proxy /api/* para
# o FastAPI, que roda o pipeline de produção de vídeos.
# ════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim

# Python + FFmpeg do sistema (o binário em bin/ é macOS — ignorado no Linux)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# ── deps Node (camada cacheável) ──
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/remotion/package.json apps/remotion/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/brain/package.json packages/brain/package.json
RUN pnpm install --frozen-lockfile

# ── deps Python do motor (camada cacheável) ──
COPY apps/translation-pipeline/requirements.txt apps/translation-pipeline/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages \
      -r apps/translation-pipeline/requirements.txt

# ── código ──
COPY . .

ENV NODE_ENV=production \
    FASTAPI_URL=http://127.0.0.1:8000 \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe

EXPOSE 3333
CMD ["bash", "start.sh"]
