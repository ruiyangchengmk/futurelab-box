#!/usr/bin/env bash
set -euo pipefail

URL="${FUTURELAB_HEALTH_URL:-http://127.0.0.1:8080/check}"

if ! curl --fail --silent --show-error --max-time 5 "$URL" >/dev/null; then
  systemctl restart futurelab-box.service
fi
