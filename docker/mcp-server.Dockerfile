# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:22.17.1-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Workspace manifests first so the install layer is cacheable across
# source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json

# Install everything so workspace symlinks resolve cleanly, then prune later.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/mcp-server ./packages/mcp-server

RUN pnpm --filter @librarian/core --filter @librarian/mcp-server run build

# Drop dev dependencies before copying into the runtime stage. `pnpm deploy`
# would also work but the workspace symlinks are simpler to reason about.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm store prune

# ---------- runtime ----------
FROM node:22.17.1-bookworm-slim AS runtime

WORKDIR /app

# git — the markdown backend commits every write to the vault.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    LIBRARIAN_DATA_DIR=/data \
    LIBRARIAN_HOST=0.0.0.0 \
    LIBRARIAN_PORT=3838

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY --from=builder /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=builder /app/packages/mcp-server/node_modules ./packages/mcp-server/node_modules

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 3838

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3838/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--no-warnings", "packages/mcp-server/dist/bin/http.js"]
