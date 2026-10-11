FROM node:22-bookworm-slim

# Chromium + Python for admin FMInside manual match (Cloudflare needs a real browser).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    g++ \
    chromium \
    fonts-liberation \
    ca-certificates \
  && pip3 install --break-system-packages --no-cache-dir beautifulsoup4 playwright \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts/scrape_fminside.py scripts/scrape_fm_player.py ./scripts/

ENV NODE_ENV=production \
    PORT=3080 \
    HOST=0.0.0.0 \
    DIN8STY_DB=/app/data/din8sty.db

EXPOSE 3080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3080/api/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]
