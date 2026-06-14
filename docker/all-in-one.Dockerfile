# syntax=docker/dockerfile:1.7

# Single-container image: runs BOTH the MCP server and the Next.js dashboard in
# one container, under `tini` (PID 1, reaps orphans) → docker/supervisor.mjs →
# the two services. See docs/specs/deploy-single-container.md.
#
# The two services live in separate subtrees (/app/mcp-server, /app/dashboard) so
# their node_modules don't collide; the supervisor runs each by absolute path, so
# Node resolves each one's modules from its own subtree regardless of cwd.

# ---------- builder ----------
FROM node:22.17.1-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Manifests first for a cacheable install layer. .pnpmfile.cjs must be present
# for --frozen-lockfile (the lockfile records its checksum; it strips
# node-llama-cpp's GPU binaries to keep the image lean).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/mcp-server ./packages/mcp-server
COPY packages/cli ./packages/cli
COPY apps/dashboard ./apps/dashboard

# core + mcp-server first (the dashboard imports mcp-server types, the admin CLI
# imports both), then the admin CLI (`@librarian/cli` → the `the-librarian` bin,
# folded into `server admin`), then the dashboard.
RUN pnpm --filter @librarian/core --filter @librarian/mcp-server run build \
  && pnpm --filter @librarian/cli run build \
  && pnpm --filter @librarian/dashboard run build

# Prune the workspace to prod deps for the mcp-server runtime tree. The dashboard's
# .next/standalone output already bundles its own pruned node_modules, so this
# doesn't affect it.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && pnpm store prune

# ---------- runtime ----------
FROM node:22.17.1-bookworm-slim AS runtime
WORKDIR /app

# tini as PID 1 reaps re-parented orphans (Node won't); the supervisor runs as
# its child. Equivalent to `docker run --init`.
# tini (PID 1) + git (the markdown backend commits every write to the vault).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    LIBRARIAN_DATA_DIR=/data \
    LIBRARIAN_HOST=0.0.0.0 \
    LIBRARIAN_PORT=3838 \
    LIBRARIAN_SERVER_URL=http://127.0.0.1:3838 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    LIBRARIAN_SUPERVISOR_CHILDREN="[{\"name\":\"mcp-server\",\"cmd\":\"node\",\"args\":[\"--no-warnings\",\"/app/mcp-server/packages/mcp-server/dist/bin/http.js\"]},{\"name\":\"dashboard\",\"cmd\":\"node\",\"args\":[\"/app/dashboard/apps/dashboard/server.js\"]}]"

# --- mcp-server runtime tree under /app/mcp-server (mirrors mcp-server.Dockerfile) ---
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/mcp-server/
COPY --from=builder /app/node_modules /app/mcp-server/node_modules
COPY --from=builder /app/packages/core/package.json /app/mcp-server/packages/core/package.json
COPY --from=builder /app/packages/core/dist /app/mcp-server/packages/core/dist
COPY --from=builder /app/packages/core/node_modules /app/mcp-server/packages/core/node_modules
COPY --from=builder /app/packages/mcp-server/package.json /app/mcp-server/packages/mcp-server/package.json
COPY --from=builder /app/packages/mcp-server/dist /app/mcp-server/packages/mcp-server/dist
COPY --from=builder /app/packages/mcp-server/node_modules /app/mcp-server/packages/mcp-server/node_modules

# --- admin CLI runtime tree under /app/cli (mirrors the mcp-server tree above) ---
# `@librarian/cli` is the `the-librarian` binary folded into `librarian server
# admin`. It lives in its own subtree so Node resolves its modules from here
# regardless of cwd, exactly like the mcp-server tree. It imports @librarian/core
# (and @librarian/mcp-server), so their built dist + node_modules come along.
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/cli/
COPY --from=builder /app/node_modules /app/cli/node_modules
COPY --from=builder /app/packages/core/package.json /app/cli/packages/core/package.json
COPY --from=builder /app/packages/core/dist /app/cli/packages/core/dist
COPY --from=builder /app/packages/core/node_modules /app/cli/packages/core/node_modules
COPY --from=builder /app/packages/mcp-server/package.json /app/cli/packages/mcp-server/package.json
COPY --from=builder /app/packages/mcp-server/dist /app/cli/packages/mcp-server/dist
COPY --from=builder /app/packages/mcp-server/node_modules /app/cli/packages/mcp-server/node_modules
COPY --from=builder /app/packages/cli/package.json /app/cli/packages/cli/package.json
COPY --from=builder /app/packages/cli/dist /app/cli/packages/cli/dist
COPY --from=builder /app/packages/cli/node_modules /app/cli/packages/cli/node_modules
# Put `the-librarian` on PATH: symlink the built bin into /usr/local/bin. The bin
# is an ESM module with its own shebang; node resolves its deps from the subtree.
RUN ln -s /app/cli/packages/cli/dist/bin.js /usr/local/bin/the-librarian \
  && chmod +x /app/cli/packages/cli/dist/bin.js

# --- dashboard standalone tree under /app/dashboard (mirrors dashboard.Dockerfile) ---
COPY --from=builder /app/apps/dashboard/.next/standalone /app/dashboard/
COPY --from=builder /app/apps/dashboard/.next/static /app/dashboard/apps/dashboard/.next/static
COPY --from=builder /app/apps/dashboard/public /app/dashboard/apps/dashboard/public

# --- supervisor ---
COPY docker/supervisor.mjs /app/supervisor.mjs

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000 3838

# Healthy only when BOTH the dashboard liveness route and the MCP server respond.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "Promise.all([fetch('http://127.0.0.1:3000/api/health'),fetch('http://127.0.0.1:3838/healthz')]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/supervisor.mjs"]
