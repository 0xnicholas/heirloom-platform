# Heirloom 镜像 —— server + CLI 同镜像（compose migrate 形态复用，spec 70 §7）
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/dsl/package.json packages/dsl/
COPY packages/example-ontology/package.json packages/example-ontology/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --filter @heirloom/server --filter @heirloom/cli
COPY packages/ packages/
RUN pnpm --filter @heirloom/server build && pnpm --filter @heirloom/cli build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["node", "packages/server/dist/start.js"]
