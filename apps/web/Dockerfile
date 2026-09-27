# apps/web/Dockerfile — web（監控台前端）的容器形態（Feature 008；research D3）
#
# build context 為 repo root（pnpm workspace 需要 lockfile 與各套件 manifest）：
#   docker compose --profile demo up -d --build
#
# 產物為純靜態檔——runtime 用 nginx，不需 node runtime 與 pnpm deploy 裁剪。
# nginx 同時提供靜態伺服與 /ws、/diagnoses 的同源反向代理（apps/web/nginx.conf）。
#
# 需 BuildKit（Docker 23+ 預設）：RUN --mount=type=cache 讓 pnpm store 跨次建置、跨三個映像共用，
# store 本身不進任何 image layer。base image 以「tag + digest」雙釘（重建可重現，升版兩者一起改）。

# ---- builder：安裝 web 建置鏈、建置 contracts/shared/web（vite build）----
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
# corepack 依 root package.json 的 packageManager 取得 lockfile 對應的 pnpm（MUST 先有 package.json 在場）
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# 1) pnpm fetch 只讀 lockfile 就把全部依賴下載進 store（cache mount），改 manifest 不讓下載重來。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --store-dir /root/.local/share/pnpm/store

# 2) 全部 workspace importers 的 package.json 都要在場：frozen lockfile 會核對全部 importers。
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/shared/package.json packages/shared/
# web 的 vite build 需要 devDependencies（vite、plugin-vue、tailwind…），故不加 --prod；
# --filter web... 只裝 web 與其 workspace 依賴，不裝 api 的 NestJS 與 worker 的 LLM SDK。
# root（flow-gatekeeper）一併選入：root devDependencies 提供 @types/node 等共用型別。
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /root/.local/share/pnpm/store \
      --filter "@flow-gatekeeper/web..." --filter flow-gatekeeper

# 複製 web 建置鏈的源碼（api/worker 源碼雖在 context 中，本映像不取用）
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY apps/web apps/web

# 依依賴順序建置：vite build 以 production 條件解析 packages 的 dist（development 條件才指向 src）
RUN pnpm --filter @flow-gatekeeper/contracts build \
 && pnpm --filter @flow-gatekeeper/shared build \
 && pnpm --filter @flow-gatekeeper/web build

# ---- runtime：非 root 的 nginx 伺服靜態產物 + 同源反向代理 ----
# nginx-unprivileged：master 行程即以 uid 101 執行（官方 nginx 映像 master 為 root），被攻破時
# 不帶 root 權限；代價是無法 bind <1024 的埠，listen 改 8080（nginx.conf、compose ports／healthcheck 同步）。
# 版本與原 nginx:alpine 同為 mainline 1.31 線。
FROM nginxinc/nginx-unprivileged:1.31.6-alpine@sha256:6a23acdfca2b9cfbcec61419e3f1426bcbedb91362f2f19306a8567423bb4612
# 取代預設站台設定為本專案的（靜態 + /ws、/diagnoses 反代）
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
