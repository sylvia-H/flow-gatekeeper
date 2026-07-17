# apps/web/Dockerfile — web（監控台前端）的容器形態（Feature 008；research D3）
#
# build context 為 repo root（pnpm workspace 需要 lockfile 與各套件 manifest）：
#   docker compose --profile demo up -d --build
#
# 產物為純靜態檔——runtime 用 nginx:alpine，不需 node runtime 與 pnpm deploy 裁剪。
# nginx 同時提供靜態伺服與 /ws、/diagnoses 的同源反向代理（apps/web/nginx.conf）。

# ---- builder：安裝 workspace、建置 contracts/shared/web（vite build）----
FROM node:22-alpine AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# 先只複製 manifests，讓依賴安裝層可被 Docker layer cache 重用。
# 全部 workspace importers 的 package.json 都要在場：frozen lockfile 會核對全部 importers。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/shared/package.json packages/shared/
# web 的 vite build 需要 devDependencies（vite、plugin-vue、tailwind…），故不加 --prod。
RUN pnpm install --frozen-lockfile

# 複製 web 建置鏈的源碼（api/worker 源碼雖在 context 中，本映像不取用）
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY apps/web apps/web

# 依依賴順序建置：contracts/shared 的 exports 指向 dist，web 由 workspace symlink 解析其型別與實作
RUN pnpm --filter @flow-gatekeeper/contracts build \
 && pnpm --filter @flow-gatekeeper/shared build \
 && pnpm --filter @flow-gatekeeper/web build

# ---- runtime：nginx 伺服靜態產物 + 同源反向代理 ----
FROM nginx:alpine
# 取代預設站台設定為本專案的（靜態 + /ws、/diagnoses 反代）
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
