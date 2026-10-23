# syntax=docker/dockerfile:1
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @firepulse/protocol --filter @firepulse/web

COPY packages ./packages
COPY apps/web ./apps/web
ARG NEXT_PUBLIC_API_URL=http://localhost:8790
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Account routes are rewritten to this address; Next.js fixes it at build time.
ARG API_INTERNAL_URL=""
ENV API_INTERNAL_URL=$API_INTERNAL_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @firepulse/protocol build && pnpm --filter @firepulse/web build

FROM node:22-slim
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
