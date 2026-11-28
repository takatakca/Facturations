# GROUPE TAKATAK — Facturations container for an isolated Coolify staging.
# Runs ONLY against its own dedicated PostgreSQL database. No Wave writes,
# invoice issuance, real email or payments are enabled by this image.
FROM node:22-bookworm-slim

# psql is needed only by the operator command that applies ops/runtime-db-grants.sql.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY app.js ./
COPY src ./src
COPY db ./db
COPY ops ./ops
COPY scripts ./scripts

USER node
EXPOSE 3000

# The production edge guard only answers the exact public host over the
# trusted HTTPS proxy, so the probe presents those headers on loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/container-healthcheck.js"]

CMD ["node", "app.js"]
