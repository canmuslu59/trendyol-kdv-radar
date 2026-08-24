FROM node:20-bookworm-slim
WORKDIR /app

# Chromium is used because Trendyol category results are rendered client-side.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CHROMIUM_PATH=/usr/bin/chromium \
    MAX_PAGES_PER_CATEGORY=25 \
    PAGE_DELAY_MS=1200 \
    PAGE_TIMEOUT_MS=30000

EXPOSE 3000
CMD ["npm","start"]
