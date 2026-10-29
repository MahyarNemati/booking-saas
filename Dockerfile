# syntax=docker/dockerfile:1

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next.config.ts validates env at build time, so provide placeholders. Real
# values come from the runtime environment.
ENV DATABASE_URL="postgres://build:build@localhost:5432/build" \
    AUTH_SECRET="build-time-placeholder-at-least-32-chars" \
    RATE_LIMIT_BACKEND="postgres" \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------------------
# Stage order matters: `runtime` is LAST, because a build with no `--target`
# produces the final stage.
#
# This file had `tools` appended after `runtime`, which silently made the
# tools image the default -- so `docker compose up app` and a
# build-push-action with no target both produced an image with no server.js,
# and the container exited instantly. Nothing in the build fails; you get a
# connection reset and no clue why. Keep `runtime` at the bottom.
# ---------------------------------------------------------------------------

# The worker, the migration runner and the seed script need the TypeScript
# sources and the dev dependencies, which the `runtime` stage below
# deliberately does not carry -- the point of `output: standalone` is an image
# holding only what serves requests.
#
# A second target rather than bloating the first: the web image stays minimal
# and the tools image is only pulled where it is actually used. Both are built
# from the same sources, so they cannot drift.
FROM node:26-alpine AS tools
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN addgroup -g 1001 nodejs && adduser -D -u 1001 -G nodejs worker
USER worker
# Overridden per service in docker-compose.yml; the worker is the default
# because it is the one that runs continuously.
CMD ["node", "--import", "tsx", "src/worker/main.ts"]

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN addgroup -g 1001 nodejs && adduser -D -u 1001 -G nodejs nextjs
# output: "standalone" emits a minimal server plus only the deps it needs.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
