# Scriptorium — single image running the collab authority + evidence server.
# Self-hostable by a non-specialist via docker compose (build spec §5, §11).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# pnpm via corepack (pinned in package.json#packageManager).
RUN corepack enable

# Install dependencies first for layer caching. Copy every workspace manifest.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/schema/package.json packages/schema/package.json
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
# Dev deps (tsx, esbuild, typescript) are needed to bundle the client and run
# the TypeScript server, so do a full install.
RUN pnpm install --frozen-lockfile --prod=false

# Copy the rest of the source and build the browser bundle.
COPY . .
RUN pnpm build:client

EXPOSE 3000

# bootstrap.ts applies migrations automatically when DATABASE_URL is set.
CMD ["pnpm", "start"]
