FROM python:3.12-slim

# Instala ffmpeg + libs de sistema necessárias para opencv-headless e yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia o código
COPY . .

# Cria diretórios necessários
RUN mkdir -p data workspace/downloads workspace/overlays workspace/outputs

EXPOSE 8000

# Railway injeta $PORT — usamos ela com fallback para 8000
CMD ["sh", "-c", "python -m uvicorn src.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
