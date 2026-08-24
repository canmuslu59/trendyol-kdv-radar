FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    MAX_PAGES_PER_CATEGORY=25 \
    PAGE_DELAY_MS=900 \
    PAGE_TIMEOUT_MS=25000 \
    DETAIL_FALLBACK=1

EXPOSE 3000
CMD ["npm","start"]
