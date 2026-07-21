# Genesis Pipeline — Dockerfile for Railway.app
# Long-running Node process that accepts PDF uploads, runs the AI
# extraction pipeline, and returns the result via polling.

FROM node:20-bookworm-slim

# System deps for canvas (libcairo + pango)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    python3 build-essential g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy pipeline source
COPY . .

# Pre-download ONNX models at build time so first request is fast
# (the cf-pages function proxy /api/walls serves walls-inline.onnx
# from GH Releases; for the Railway pipeline we ship the model
# inline as part of the image)
ARG MODEL_URL=https://huggingface.co/Yytsi/floorplan-to-3d-walls/resolve/main/best.safetensors
ARG MODEL_LOCAL=models/best.safetensors
RUN mkdir -p models && \
    if [ ! -f "$MODEL_LOCAL" ]; then \
      echo "Downloading model…"; \
      curl -sL "$MODEL_URL" -o "$MODEL_LOCAL"; \
    fi
RUN ls -lh models/

# Persistent storage for jobs. On Railway, attach a volume mounted at /var/data.
ENV DATA_DIR=/var/data
RUN mkdir -p $DATA_DIR && chown -R node:node $DATA_DIR

USER node

EXPOSE 8080

CMD ["node", "server.js"]