# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:22.17.1-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/classifier/package.json ./packages/classifier/package.json
COPY packages/classifier-eval/package.json ./packages/classifier-eval/package.json
COPY packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/classifier ./packages/classifier
COPY packages/classifier-eval ./packages/classifier-eval
COPY packages/mcp-server ./packages/mcp-server
COPY apps/dashboard ./apps/dashboard

# The dashboard imports types from @librarian/mcp-server (which imports
# @librarian/classifier + @librarian/classifier-eval). Build the chain
# in order so .d.ts files are emitted under dist/ before the dashboard
# build resolves them.
RUN pnpm --filter @librarian/core --filter @librarian/classifier --filter @librarian/classifier-eval --filter @librarian/mcp-server run build \
  && pnpm --filter @librarian/dashboard run build

# ---------- runtime ----------
# Next.js produces a self-contained server bundle under .next/standalone.
# It already includes a pruned node_modules tree, so we ship just that
# plus the static assets and the public/ folder.
FROM node:22.17.1-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder /app/apps/dashboard/public ./apps/dashboard/public

RUN chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/dashboard/server.js"]
