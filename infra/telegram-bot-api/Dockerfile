FROM ghcr.io/gramiojs/telegram-bot-api:latest

USER root
COPY infra/telegram-bot-api/entrypoint.sh /movieshub-telegram-api-entrypoint.sh
RUN chmod 755 /movieshub-telegram-api-entrypoint.sh
USER telegram-bot-api

EXPOSE 8080/tcp 8081/tcp 8082/tcp
ENTRYPOINT ["/sbin/tini", "-g", "--", "/movieshub-telegram-api-entrypoint.sh"]
