# syntax=docker/dockerfile:1
# Build context is the repository root. Output is static assets served by caddy.
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm CI=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/ai/package.json packages/ai/
COPY packages/canvas-engine/package.json packages/canvas-engine/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/integrations/package.json packages/integrations/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/query-engine/package.json packages/query-engine/
COPY packages/transforms/package.json packages/transforms/
COPY packages/ui/package.json packages/ui/
COPY bench/package.json bench/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @nexus/ui run build && pnpm --filter @nexus/web run build

FROM caddy:2-alpine AS runtime
# Pick up the Alpine security updates published after the base image was built (Trivy gates the
# image on HIGH/CRITICAL; 15_SECURITY.md §9.4).
RUN apk upgrade --no-cache
COPY --from=build --chown=65532:65532 /repo/apps/web/dist /srv
COPY infra/docker/web.Caddyfile /etc/caddy/Caddyfile
USER 65532:65532
EXPOSE 8080
