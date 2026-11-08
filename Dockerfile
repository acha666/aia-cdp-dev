ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app
RUN npm install -g pnpm@12
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm --version

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --store-dir /pnpm/store --prod --frozen-lockfile --ignore-scripts

FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --store-dir /pnpm/store --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json tsconfig.node.json tsconfig.build.json vite.config.ts ./
COPY src ./src
ARG VITE_SITE_NAME
RUN pnpm run build:web && pnpm run build:server

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server/runtime/node.js"]
