#!/usr/bin/env bash
# The far end of the deploy: everything the CI runner's key is allowed to do, and nothing else.
#
# The host's ~/.ssh/authorized_keys pins this as a forced command, so the image tag is the only
# thing the runner gets to choose:
#
#   command="/home/vps-1/GrassToucher/deploy/host-deploy.sh",restrict ssh-ed25519 AAAA… deploy@github-actions
#
# A forced command replaces whatever the client asked to run and leaves that string in
# SSH_ORIGINAL_COMMAND, which is why the tag arrives there rather than in "$1".
set -euo pipefail

# The compose file and its .env are this script's grandparent directory, so the deploy path is
# derived instead of passed in. A directory the runner could name would defeat the point of
# pinning the command.
cd "$(dirname "$(readlink -f "$0")")/.."

TAG="${SSH_ORIGINAL_COMMAND:-latest}"

# This is about to be interpolated into an image reference, so it's checked against the two
# shapes publish.yml actually pushes rather than trusted.
if [[ ! $TAG =~ ^([0-9a-f]{7,40}|latest)$ ]]; then
  echo "Refusing to deploy: '$TAG' is not a commit sha or 'latest'" >&2
  exit 64
fi
export TAG

echo "Deploying $TAG from $PWD"
docker compose pull

# --no-build because docker-compose.yaml keeps a `build:` section for local use. Without this a
# tag missing from GHCR wouldn't fail — it would quietly build whatever the host's checkout
# happens to be sitting on and call that a deploy.
docker compose up -d --no-build --remove-orphans

# The bot reads its config and logs into Discord at boot, so a bad token or a missing channel id
# crashes it seconds after a "successful" deploy. Catch that here instead of finding out when
# nobody can create an event.
sleep 8
if [[ -z "$(docker compose ps --status running --quiet)" ]]; then
  echo "Container is not running after deploy" >&2
  docker compose logs --tail=50
  exit 1
fi

docker compose ps

# The image this one replaced has no readers left, and this host builds media containers too —
# untagged layers add up fast on a VPS disk.
docker image prune -f
