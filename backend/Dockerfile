# ---------------------------------------------------------------------------
# ServiceDesk AI — API image
#
# Multi-stage: the build stage carries TypeScript and dev dependencies, the
# runtime stage carries only compiled JavaScript and production dependencies.
# ---------------------------------------------------------------------------

FROM node:20-alpine AS build
WORKDIR /app

# Copied separately so a source-only change does not invalidate the dependency
# layer and force a full reinstall on every build.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations are read from disk at runtime by the migrate command, so the .sql
# files must be present in the image; tsc does not copy them.
COPY src/db/migrations ./dist/db/migrations

# Run as a non-root user: a container process should not be root by default.
USER node

EXPOSE 4000

# Checks the process AND the database, so an instance that cannot reach
# Postgres is reported unhealthy rather than silently serving errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:4000/api/health || exit 1

CMD ["node", "dist/server.js"]
