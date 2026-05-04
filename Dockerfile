# Multi-stage build:
#   1. "builder" downloads all ISM OSCAL releases and compiles TypeScript.
#   2. "runtime" is a slim image with only the artefacts needed at runtime.
#
# The resulting image runs fully offline (ISM_MCP_OFFLINE=1) by default.

# ---- builder ---------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Compile TypeScript and bundle every published ISM release into ./data.
RUN npm run build && node scripts/fetch-data.mjs

# Strip dev dependencies for the runtime image.
RUN npm prune --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    ISM_MCP_OFFLINE=1 \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8080

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/data ./data
COPY --from=builder /build/scripts ./scripts
COPY --from=builder /build/package.json ./package.json
COPY README.md LICENSE* ./

EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["node", "/app/dist/index.js"]
