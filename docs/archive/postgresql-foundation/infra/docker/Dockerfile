FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
RUN pnpm build:core
RUN pnpm prune --prod

FROM node:24.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build/apps ./build/apps
COPY --from=build --chown=node:node /app/build/packages ./packages
COPY --from=build --chown=node:node /app/packages/auth/package.json ./packages/auth/package.json
COPY --from=build --chown=node:node /app/packages/authz/package.json ./packages/authz/package.json
COPY --from=build --chown=node:node /app/packages/config/package.json ./packages/config/package.json
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=node:node /app/packages/messaging/package.json ./packages/messaging/package.json
COPY --from=build --chown=node:node /app/packages/observability/package.json ./packages/observability/package.json
COPY --from=build --chown=node:node /app/packages/payments/package.json ./packages/payments/package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/storage/package.json ./packages/storage/package.json
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000

FROM runtime AS api
CMD ["node", "build/apps/api/src/main.js"]

FROM runtime AS worker
CMD ["node", "build/apps/worker/src/main.js"]

FROM runtime AS migrator
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
CMD ["node", "build/apps/migrator/src/main.js"]
