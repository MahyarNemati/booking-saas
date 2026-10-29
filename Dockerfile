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
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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
