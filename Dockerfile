# ════════════════════════════════════════════════════════════════
# Fold Videos — Apenas o site Express (frontend + proxy)
# O backend Python roda em serviço separado (soothing-intuition)
# ════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# ── deps Node (camada cacheável) ──
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/brain/package.json packages/brain/package.json
RUN pnpm install --frozen-lockfile

# ── código ──
COPY apps/web apps/web
COPY packages packages

ENV NODE_ENV=production
ENV FASTAPI_URL=http://localhost:8000

EXPOSE 3333

# FASTAPI_URL é injetado pelo Railway como variável de ambiente
CMD ["sh", "-c", "cd /app/apps/web && exec npx tsx src/server.ts"]
