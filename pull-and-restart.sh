#!/usr/bin/env bash
# Pull main and rebuild the two-service Docker stack in place.
#
# Safe to run from any branch — stashes local changes, checks out main,
# deploys only if origin/main has advanced, then restores the original
# branch and unstashes.  Idempotent; no-ops when already up to date.
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
LOCKFILE="/tmp/librarian-auto-deploy.lock"
LOGFILE="/tmp/librarian-auto-deploy.log"

# ── helpers ──────────────────────────────────────────────────────

log() { echo "$(date -Iseconds)  $*" >> "$LOGFILE"; }

# Restore the original branch and pop any stash we created.
restore_state() {
  if [ "${ORIG_BRANCH:-}" != "main" ] && [ -n "${ORIG_BRANCH:-}" ]; then
    git checkout "$ORIG_BRANCH" 2>/dev/null || true
    log "switched back to $ORIG_BRANCH"
  fi
  if ${STASHED:-false}; then
    git stash pop 2>/dev/null || true
    log "restored stash"
  fi
}

# ── guard against concurrent runs ────────────────────────────────

exec 200>"$LOCKFILE"
if ! flock -n 200; then
  log "deploy already in progress, skipping"
  exit 0
fi

# ── preflight ────────────────────────────────────────────────────

if [ ! -f .env ]; then
  echo "error: .env not found in $REPO_ROOT — copy .env.example and set tokens before running" >&2
  exit 1
fi

ORIG_BRANCH="$(git branch --show-current)"
STASHED=false

if ! git diff-index --quiet HEAD --; then
  log "stashing local changes on $ORIG_BRANCH"
  git stash push --include-untracked --message "pull-and-restart: auto-stash before deploy" 2>>"$LOGFILE"
  STASHED=true
fi

if [ "$ORIG_BRANCH" != "main" ]; then
  git checkout main 2>>"$LOGFILE"
fi

# ── check for new commits ────────────────────────────────────────

log "checking for new commits on origin/main"
git fetch --quiet origin main 2>>"$LOGFILE"

if git merge-base --is-ancestor main origin/main && \
   git merge-base --is-ancestor origin/main main; then
  log "already at origin/main, nothing to deploy"
  restore_state
  exit 0
fi

log "origin/main has new commits — triggering deploy"

# ── deploy ───────────────────────────────────────────────────────

OLD_HEAD="$(git rev-parse HEAD)"

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
  for endpoint in "http://100.84.165.31:3838/healthz" "http://100.84.165.31:3839/health"; do
    for _ in $(seq 1 15); do
      if curl -sf "$endpoint" >/dev/null 2>&1; then
        echo "  $endpoint: OK"
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

# ── announce ─────────────────────────────────────────────────────

NEW_HEAD="$(git rev-parse HEAD)"

# Source webhook URL from .env
DISCORD_WEBHOOK="$(grep -oP '^LIBRARIAN_DISCORD_WEBHOOK=\K.*' .env 2>/dev/null || true)"

if [ -n "$DISCORD_WEBHOOK" ] && [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
  # Build commit list (max 5, newest first)
  COMMITS="$(git log --oneline --no-merges "${OLD_HEAD}..${NEW_HEAD}" | head -5)"
  COMMIT_COUNT="$(git rev-list --count "${OLD_HEAD}..${NEW_HEAD}")"
  SHORT_OLD="$(echo "$OLD_HEAD" | cut -c1-7)"
  SHORT_NEW="$(echo "$NEW_HEAD" | cut -c1-7)"

  # Build Discord embed payload — use a temp file to avoid shell
  # interpreting backticks in commit hashes as command substitution.
  DESC_FILE="$(mktemp)"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    HASH="$(echo "$line" | cut -d' ' -f1)"
    MSG="$(echo "$line" | cut -d' ' -f2-)"
    printf '\n`%s` %s' "$HASH" "$MSG" >> "$DESC_FILE"
  done <<< "$COMMITS"

  curl -sf -X POST "$DISCORD_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --rawfile desc "$DESC_FILE" \
      --arg url "https://github.com/JimJafar/the-librarian/compare/${SHORT_OLD}...${SHORT_NEW}" \
      '{
        embeds: [{
          title: "📦 The Librarian deployed",
          description: $desc,
          url: $url,
          color: 3066993,
          footer: { text: "guybrush · auto-deploy" },
          timestamp: now
        }]
      }')" 2>>"$LOGFILE" && log "discord announcement sent" || log "discord announcement failed"

  rm -f "$DESC_FILE"
fi

# ── restore ──────────────────────────────────────────────────────

restore_state
echo "==> done"
