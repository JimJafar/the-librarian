#!/usr/bin/env bash
# Pull main and rebuild the two-service Docker stack in place.
#
# Run from anywhere on the VPS; the script chdirs into the repo root
# and passes `--env-file .env` so the compose stack picks up the
# tokens. The data volume (`librarian_data`) is preserved across the
# restart.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker/docker-compose.yml"

if [ ! -f .env ]; then
  echo "error: .env not found in $REPO_ROOT — copy .env.example and set tokens before running" >&2
  exit 1
fi

echo "==> git pull"
git pull --ff-only

echo "==> docker compose down (preserving data volume)"
docker compose --env-file .env -f "$COMPOSE_FILE" down

echo "==> docker compose up --build"
docker compose --env-file .env -f "$COMPOSE_FILE" up -d --build

echo "==> waiting for healthchecks"
# "<container>:<compose service>" — service name is used for log fetches.
for pair in "librarian-mcp:mcp-server" "librarian-dashboard:dashboard"; do
  container="${pair%%:*}"
  service="${pair#*:}"
  status=""
  for _ in $(seq 1 30); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo "missing")"
    case "$status" in
      healthy) echo "  $service: healthy"; break ;;
      unhealthy) echo "  $service: unhealthy" >&2; docker compose --env-file .env -f "$COMPOSE_FILE" logs --tail=50 "$service" >&2; exit 1 ;;
      *) sleep 2 ;;
    esac
  done
  if [ "$status" != "healthy" ]; then
    echo "  $service: did not reach healthy state within 60s" >&2
    docker compose --env-file .env -f "$COMPOSE_FILE" logs --tail=50 "$service" >&2
    exit 1
  fi
done

echo "==> done"
