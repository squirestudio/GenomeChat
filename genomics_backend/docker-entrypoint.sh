#!/bin/sh
# Guard against the stale-image trap.
#
# docker-compose bind-mounts the source dir over /app, so source edits are live
# but installed packages are not — they live in the image. If requirements.txt
# changes and the image isn't rebuilt, the container runs current code against
# stale site-packages and dies with a ModuleNotFoundError whose traceback points
# at an import line, which reads like a code bug.
#
# The image records the checksum of the requirements.txt it was built from, at a
# path outside /app so the bind mount cannot shadow it. If the mounted file no
# longer matches, the image is stale by definition — refuse to start and say so.
#
# In production (Railway, plain `docker run`) there is no bind mount, so
# /app/requirements.txt IS the baked file and this check always passes.
set -e

BAKED_SUM_FILE=/opt/genomechat/requirements.sha256
LIVE_REQUIREMENTS=/app/requirements.txt

if [ -f "$BAKED_SUM_FILE" ] && [ -f "$LIVE_REQUIREMENTS" ]; then
    baked_sum=$(cat "$BAKED_SUM_FILE")
    live_sum=$(sha256sum "$LIVE_REQUIREMENTS" | cut -d' ' -f1)

    if [ "$baked_sum" != "$live_sum" ]; then
        cat >&2 <<EOF

┌──────────────────────────────────────────────────────────────────────┐
│  STALE IMAGE — refusing to start                                     │
└──────────────────────────────────────────────────────────────────────┘

requirements.txt has changed since this image was built, so the installed
packages no longer match the code being mounted. Starting anyway would fail
later with a confusing ModuleNotFoundError at some import line.

Rebuild:

    docker compose up -d --build

(Or use 'docker compose watch', which rebuilds on requirements.txt changes
automatically — see the develop.watch block in docker-compose.yml.)

  image built from requirements.txt sha256: $baked_sum
  currently mounted requirements.txt sha256: $live_sum

EOF
        exit 1
    fi
fi

exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
