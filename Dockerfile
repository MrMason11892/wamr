# Combined Build - Baileys + Node.js
# Uses Node for both building and runtime (better-sqlite3 native bindings require Node.js ABI)

# Build stage - Node for reliable npm install
FROM node:24-slim AS builder

WORKDIR /app

# Install build dependencies (git for Baileys, python/make/g++ for native modules without a prebuild)
RUN apt-get update && apt-get install -y --no-install-recommends \
  git python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
  && git config --global url."https://github.com/".insteadOf git@github.com:

# Backend and frontend install standalone from their own audited lockfiles
COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/scripts ./backend/scripts
COPY frontend/package.json frontend/package-lock.json ./frontend/

WORKDIR /app/backend
RUN npm ci \
  && grep -q _wamrShouldProcess node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js

WORKDIR /app/frontend
RUN npm ci

# Copy source files
WORKDIR /app
COPY backend/tsconfig.json backend/build.js ./backend/
COPY backend/src ./backend/src
COPY backend/drizzle ./backend/drizzle
COPY backend/drizzle.config.ts ./backend/
COPY frontend/tsconfig*.json frontend/vite.config.ts frontend/components.json ./frontend/
COPY frontend/postcss.config.js frontend/tailwind.config.ts frontend/index.html ./frontend/
COPY frontend/src ./frontend/src
COPY frontend/public ./frontend/public

# Build backend, then drop dev dependencies for the runtime image
WORKDIR /app/backend
RUN npm run build && npm prune --omit=dev

# Build frontend
WORKDIR /app/frontend
ARG VITE_API_URL=
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# Production stage - Node.js runtime (required for better-sqlite3 native bindings)
FROM node:24-slim

WORKDIR /app

# Install runtime deps (git for Baileys)
RUN apt-get update && apt-get install -y --no-install-recommends \
  git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
  && git config --global url."https://github.com/".insteadOf git@github.com:

# Copy package.json and production node_modules (native modules built for this Node ABI)
COPY backend/package.json ./package.json
COPY --from=builder /app/backend/node_modules ./node_modules

# Copy built artifacts
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/frontend/dist ./public
COPY backend/drizzle ./drizzle
COPY backend/drizzle.config.ts ./

# Create directories for volumes
RUN mkdir -p /app/.baileys_auth /app/data

ENV NODE_ENV=production

# Port can be overridden via environment variable
ENV PORT=9000
EXPOSE ${PORT}

# Startup script
RUN printf '#!/bin/sh\nset -e\necho "Running migrations..."\nnode dist/database/migrate.js\necho "Running seed..."\nnode dist/database/seed.js\necho "Starting server..."\nexec node dist/index.js\n' > /docker-entrypoint.sh \
  && chmod +x /docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 9000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["/docker-entrypoint.sh"]
