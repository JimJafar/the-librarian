#!/usr/bin/env bash
# Pull main and rebuild the two-service Docker stack in place.
#
# Run from anywhere on the VPS; the script chdirs into the repo root.
# If the systemd service (the-librarian.service) is managing the stack,
# uses systemctl restart. Otherwise falls back to raw docker compose.
#
# The data volume (`librarian_data`) is preserved across the restart.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

COMPOSE_ARGS="-f docker/docker-compose.yml --env-file .env"
SERVICE_NAME="the-librarian.service"

if [ ! -f .env ]; then
  echo "error: .env not found in $REPO_ROOT — copy .env.example and set tokens before running" >&2
  exit 1
fi

echo "==> git pull"
git pull --ff-only

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "==> systemd-managed: restarting $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  echo "==> checking service status"
  sleep 3
  systemctl status --no-pager "$SERVICE_NAME"
  echo ""
  echo "==> verifying healthchecks"
  for pair in "http://100.84.165.31:3838/healthz" "http://100.84.165.31:3839/health"; do
    for _ in $(seq 1 15); do
      if curl -sf "$pair" >/dev/null 2>&1; then
        echo "  $pair: OK"
        break
      fi
      sleep 2
    done
  done
else
  echo "==> docker compose down (preserving data volume)"
  docker compose $COMPOSE_ARGS down

  echo "==> docker compose up --build"
  docker compose $COMPOSE_ARGS up -d --build

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
        unhealthy) echo "  $service: unhealthy" >&2; docker compose $COMPOSE_ARGS logs --tail=50 "$service" >&2; exit 1 ;;
        *) sleep 2 ;;
      esac
    done
    if [ "$status" != "healthy" ]; then
    echo "  $service: did not reach healthy state within 60s" >&2
    docker compose $COMPOSE_ARGS logs --tail=50 "$service" >&2
      exit 1
    fi
  done
fi

echo "==> done"
