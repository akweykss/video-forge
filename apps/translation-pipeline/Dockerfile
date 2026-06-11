FROM python:3.12-slim

# Instala as bibliotecas de sistema que o opencv/paddleocr precisam
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    ffmpeg \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install opencv-python-headless==4.11.0.86 --force-reinstall

# Copia o código
COPY . .

# Cria pasta de dados
RUN mkdir -p data workspace/downloads workspace/overlays workspace/outputs

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8000"]
