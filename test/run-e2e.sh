#!/usr/bin/env bash
# 端到端测试：用独立端口与临时数据文件启动服务，跑完即停。
set -euo pipefail

PORT=3099
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DB="$(mktemp -d)/core-slices.json"
trap 'kill "${SERVER_PID:-}" 2>/dev/null || true; rm -rf "$(dirname "$TMP_DB")"' EXIT

cp "$BASE_DIR/data/core-slices.json" "$TMP_DB"
CORE_DB_PATH="$TMP_DB" PORT=$PORT node "$BASE_DIR/server.js" &
SERVER_PID=$!

for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/api/samples" >/dev/null && break
  sleep 0.2
done

BASE="http://localhost:$PORT" node "$BASE_DIR/test/e2e.mjs"
