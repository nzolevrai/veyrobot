FROM node:24.21.0-bookworm-slim AS build
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
RUN pnpm install --frozen-lockfile && pnpm db:generate && pnpm build

FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
COPY --from=build /workspace ./
EXPOSE 3000 4000
CMD ["pnpm", "--filter", "@veyrobot/api", "start"]
