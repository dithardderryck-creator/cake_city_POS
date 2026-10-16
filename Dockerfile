# One image that builds the pages and the server and runs them together, for a hosted copy.
# Used by the free test copy (see docs/test-copy.md). The shop computer does not need Docker.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Build tools only in case better-sqlite3 has no ready-made binary for this system.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# Dev dependencies are needed to build, so install everything first.
RUN npm ci --include=dev --no-audit --no-fund && npm run build
ENV DATA_DIR=/data \
    TZ=Africa/Dar_es_Salaam \
    HOST=0.0.0.0
RUN mkdir -p /data
EXPOSE 10000
CMD ["node", "scripts/start.mjs"]
