#!/usr/bin/env bash
# 端到端冒烟的本地依赖栈：Postgres + MinIO（S3 兼容）+ Redis。
#
# 为什么需要它：冒烟一路卡在数据库写入，根因是**没有对象存储**——生成的图会以
# data: URL 整个塞进 Postgres 的任务负载（1.7MB 图 → base64 约 2.25MB → 写 jsonb）。
# 小请求一直正常，几 MB 的写入在 TUN 代理下就断。
#
# 起了本地栈之后，整条链路只剩 OpenAI 走网络，而它一直是好的。
#
#   ./scripts/smokeLocalStack.sh up     # 启动
#   ./scripts/smokeLocalStack.sh down   # 停止并删除
#   ./scripts/smokeLocalStack.sh env    # 打印要写进 .env 的配置
set -euo pipefail

PG_NAME=botanic-smoke-pg
S3_NAME=botanic-smoke-s3
REDIS_NAME=botanic-smoke-redis
BUCKET=botanic-media

case "${1:-up}" in
  up)
    docker info >/dev/null 2>&1 || { echo "Docker 未运行，请先启动 Docker Desktop。"; exit 1; }

    docker rm -f "$PG_NAME" "$S3_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true

    echo "启动 Postgres…"
    docker run -d --name "$PG_NAME" \
      -e POSTGRES_PASSWORD=botanic -e POSTGRES_DB=botanic \
      -p 55432:5432 postgres:16-alpine >/dev/null

    echo "启动 MinIO（S3 兼容）…"
    docker run -d --name "$S3_NAME" \
      -e MINIO_ROOT_USER=botanic -e MINIO_ROOT_PASSWORD=botanic123 \
      -p 59000:9000 quay.io/minio/minio server /data >/dev/null

    echo "启动 Redis…"
    docker run -d --name "$REDIS_NAME" -p 56379:6379 redis:7-alpine >/dev/null

    echo -n "等待 Postgres 就绪"
    for _ in $(seq 1 60); do
      docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break
      echo -n "."; sleep 1
    done
    echo " 就绪"

    # MinIO 需要先建桶，否则媒体写入会 404。
    echo -n "创建 S3 桶"
    for _ in $(seq 1 30); do
      if docker run --rm --network host --entrypoint sh quay.io/minio/mc -c \
        "mc alias set local http://127.0.0.1:59000 botanic botanic123 >/dev/null 2>&1 && \
         mc mb --ignore-existing local/$BUCKET >/dev/null 2>&1"; then
        break
      fi
      echo -n "."; sleep 1
    done
    echo " 就绪"

    echo
    echo "本地栈已启动。把下面几行写进 .env（覆盖同名项）："
    "$0" env
    ;;

  env)
    cat <<'ENVEOF'
DATABASE_URL=postgresql://postgres:botanic@127.0.0.1:55432/botanic
REDIS_URL=redis://127.0.0.1:56379
BOTANIC_STORAGE_PROVIDER=s3
S3_ENDPOINT=http://127.0.0.1:59000
S3_BUCKET=botanic-media
S3_ACCESS_KEY_ID=botanic
S3_SECRET_ACCESS_KEY=botanic123
S3_FORCE_PATH_STYLE=true
ENVEOF
    ;;

  down)
    docker rm -f "$PG_NAME" "$S3_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
    echo "本地栈已停止并删除（数据未持久化，一并清掉）。"
    ;;

  *)
    echo "用法：$0 [up|down|env]"; exit 1
    ;;
esac
