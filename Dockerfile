# syntax=docker/dockerfile:1

# ---- build: compile TypeScript, then drop dev dependencies --------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: only compiled code and production dependencies, as an unprivileged user -----------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node

# One image, two tiers: APP_ROLE=api (HTTP, default port 3000) or APP_ROLE=worker (queue workers + probe port 3001).
# Leave APP_ROLE unset to run both in one process.
EXPOSE 3000 3001
# Liveness for whichever tier this is: the API listens on PORT, the worker on WORKER_PORT.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:$([ "$APP_ROLE" = worker ] && echo "${WORKER_PORT:-3001}" || echo "${PORT:-3000}")/health/live" >/dev/null || exit 1
# `node` (not npm) as PID 1 so SIGTERM reaches the app and graceful shutdown runs.
CMD ["node", "dist/main.js"]
