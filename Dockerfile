# Heirloom 镜像 —— server + CLI 同镜像（compose migrate 形态复用，spec 70 §7）
# 两段式：build 阶段全量安装（构建工具链：tsc/esbuild）+ 产物构建；
# runtime 阶段仅生产依赖（--prod 过滤安装）+ dist 覆盖。
# 注意：宿主 node_modules/dist 由 .dockerignore 隔离（平台二进制/陈旧产物
# 覆盖容器内安装的坑）。
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/dsl/package.json packages/dsl/
COPY packages/example-ontology/package.json packages/example-ontology/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY packages/ packages/
RUN pnpm --filter @heirloom/server build && pnpm --filter @heirloom/cli build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/dsl/package.json packages/dsl/
COPY packages/example-ontology/package.json packages/example-ontology/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --filter @heirloom/dsl --filter @heirloom/engine --filter @heirloom/server --filter @heirloom/cli --prod
COPY --from=build /app/packages/dsl/dist packages/dsl/dist
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/cli/dist packages/cli/dist
# 示例本体随镜像（容器内 heirloom ontology apply 演示路径）
COPY packages/example-ontology/ontology.ts packages/example-ontology/ontology.ts
EXPOSE 3000
CMD ["node", "packages/server/dist/start.js"]
