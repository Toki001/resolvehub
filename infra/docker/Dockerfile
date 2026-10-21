# One build graph, three independently deployable production targets.
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS build
ENV PNPM_HOME=/pnpm NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace
RUN npm install --global pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY services/api/package.json ./services/api/
COPY services/worker/package.json ./services/worker/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/generated/package.json ./packages/generated/
COPY packages/db/package.json ./packages/db/
COPY packages/ai/package.json ./packages/ai/
COPY packages/telemetry/package.json ./packages/telemetry/
# Optional private registry credentials exist only during this instruction.
# No application credentials or public NEXT_PUBLIC_* secrets belong in builds.
RUN --mount=type=cache,id=resolvehub-pnpm,target=/pnpm/store \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .
RUN pnpm build
RUN --mount=type=cache,id=resolvehub-pnpm,target=/pnpm/store \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    pnpm --filter @resolvehub/api deploy --prod --store-dir=/pnpm/store /out/api \
    && pnpm --filter @resolvehub/worker deploy --prod --store-dir=/pnpm/store /out/worker

FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps
WORKDIR /app
RUN groupadd --gid 10001 resolvehub \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin resolvehub
COPY --chown=10001:10001 infra/docker/entrypoint.mjs infra/docker/healthcheck.mjs ./
USER 10001:10001
ENTRYPOINT ["node", "--import", "./entrypoint.mjs"]

FROM runtime AS api
COPY --from=build --chown=10001:10001 /out/api/ ./
COPY --chown=10001:10001 infra/docker/migrate.mjs ./migrate.mjs
COPY --chown=10001:10001 packages/db/migrations/ ./migrations/
COPY --chown=10001:10001 infra/docker/runtime-grants.sql infra/docker/worker-grants.sql ./grants/
ENV API_HOST=0.0.0.0 API_PORT=3001 HEALTH_PORT=3001 HEALTH_PATH=/health/live
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=10001:10001 /out/worker/ ./
ENV WORKER_HOST=0.0.0.0 WORKER_PORT=3002 HEALTH_PORT=3002 HEALTH_PATH=/health/live
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["dist/main.js"]

FROM runtime AS web
ENV NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 HEALTH_PORT=3000 HEALTH_PATH=/api/health
COPY --from=build --chown=10001:10001 /workspace/apps/web/.next/standalone/ ./
COPY --from=build --chown=10001:10001 /workspace/apps/web/.next/static/ ./apps/web/.next/static/
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["apps/web/server.js"]
