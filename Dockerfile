FROM node:22.17.1-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    LIBRARIAN_DATA_DIR=/data \
    LIBRARIAN_HOST=0.0.0.0 \
    LIBRARIAN_PORT=3838

COPY package.json README.md ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY skills ./skills

RUN mkdir -p /data \
  && chown -R node:node /app /data

USER node

EXPOSE 3838

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://0.0.0.0:3838/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--no-warnings", "src/dashboard.js"]
