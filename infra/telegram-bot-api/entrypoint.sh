#!/bin/sh
set -eu

: "${TELEGRAM_API_ID:?TELEGRAM_API_ID is required}"
: "${TELEGRAM_API_HASH:?TELEGRAM_API_HASH is required}"
: "${FILE_SERVER_PASSWORD:?FILE_SERVER_PASSWORD is required}"

FILE_SERVER_USERNAME="${FILE_SERVER_USERNAME:-movieshubfiles}"
TELEGRAM_WORK_DIR="${TELEGRAM_WORK_DIR:-/var/lib/telegram-bot-api}"
TELEGRAM_HTTP_PORT="${TELEGRAM_HTTP_PORT:-8081}"
TELEGRAM_STAT_PORT="${TELEGRAM_STAT_PORT:-8082}"
FILE_SERVER_PORT="${FILE_SERVER_PORT:-8080}"

mkdir -p /tmp/nginx/tmp
salt="$(openssl rand -hex 8)"
password_hash="$(openssl passwd -apr1 -salt "$salt" "$FILE_SERVER_PASSWORD")"
printf '%s:%s\n' "$FILE_SERVER_USERNAME" "$password_hash" > /tmp/nginx/.htpasswd
chmod 600 /tmp/nginx/.htpasswd

cat > /tmp/nginx/nginx.conf <<EOF
worker_processes 1;
daemon off;
pid /tmp/nginx/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 1024; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log /dev/stdout;
    client_body_temp_path /tmp/nginx/tmp;
    proxy_temp_path /tmp/nginx/tmp;
    sendfile on;
    server {
        listen ${FILE_SERVER_PORT};
        client_max_body_size 0;
        location = /healthz {
            access_log off;
            default_type text/plain;
            return 200 "ok\\n";
        }
        location ^~ /bot {
            proxy_pass http://127.0.0.1:${TELEGRAM_HTTP_PORT};
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_read_timeout 900s;
            proxy_send_timeout 900s;
        }
        location / {
            auth_basic "MoviesHub files";
            auth_basic_user_file /tmp/nginx/.htpasswd;
            root ${TELEGRAM_WORK_DIR};
            autoindex off;
            sendfile on;
            tcp_nopush on;
        }
    }
}
EOF

nginx -c /tmp/nginx/nginx.conf &

exec telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --local \
  --http-port="$TELEGRAM_HTTP_PORT" \
  --http-stat-port="$TELEGRAM_STAT_PORT" \
  --http-ip-address=127.0.0.1 \
  --http-stat-ip-address=127.0.0.1 \
  --dir="$TELEGRAM_WORK_DIR"
