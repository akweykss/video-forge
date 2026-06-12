#!/usr/bin/env bash
set -e

# diretórios persistentes (monte um Volume da Railway em /data)
mkdir -p "${FOLD_WORKSPACE_DIR:-/app/apps/translation-pipeline/workspace}"
mkdir -p "$(dirname "${FOLD_DB_PATH:-/app/apps/translation-pipeline/data/pipeline.db}")"

# motor (FastAPI) em segundo plano
( cd /app/apps/translation-pipeline \
  && exec python3 -m uvicorn src.server:app --host 0.0.0.0 --port 8000 ) &

# site (Express) em primeiro plano — Railway injeta $PORT
cd /app/apps/web
exec npx tsx src/server.ts
