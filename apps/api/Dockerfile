# syntax=docker/dockerfile:1
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app

# Install only what the API workspace needs.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @firepulse/protocol --filter @firepulse/api

COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @firepulse/protocol build && pnpm --filter @firepulse/api build

# Spread forecasts: fetch the ONNX model + CONUS static layers at build time.
# SPREAD_ASSETS_URL must hold firesight-best.onnx, firesight-model.json and
# static_conus.tar.gz. Without it the image builds and spread stays off.
ARG SPREAD_ASSETS_URL=""
RUN SPREAD_ASSETS_URL="$SPREAD_ASSETS_URL" node apps/api/dist/spread/assets.js

FROM node:22-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
# The API applies db/migrations at startup.
COPY db ./db
EXPOSE 8790
CMD ["node", "apps/api/dist/index.js"]
