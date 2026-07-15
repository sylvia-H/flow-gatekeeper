# apps/worker/Dockerfile — worker 受監督形態的映像（Feature 007；research D1/D2）
#
# build context 為 repo root（pnpm workspace 需要 lockfile 與各套件 manifest）：
#   docker compose --profile supervised up -d --build
#
# 憲章 VI：祕密絕不烘入 image——.dockerignore 已把 **/.env 排除在 context 外，
# 祕密於執行時由 compose 的 env_file 注入。

# ---- builder：安裝 workspace、建置 contracts/shared/worker、裁剪 production 依賴 ----
FROM node:22-alpine AS builder
# corepack 依 root package.json 的 packageManager 取得 lockfile 對應的 pnpm 9
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# 先只複製 manifests，讓依賴安裝層可被 Docker layer cache 重用（改源碼不重裝依賴）。
# api/web 的 package.json 也要在場：frozen lockfile 會核對全部 workspace importers。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# 只複製 worker 建置鏈需要的源碼（api/web 源碼自 008 起也在 context 中，本映像不取用）
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY apps/worker apps/worker

# 依依賴順序建置：contracts/shared 的 exports 指向 dist，build 後即可被 node 原生解析（不需 bundler）
RUN pnpm --filter @flow-gatekeeper/contracts build \
 && pnpm --filter @flow-gatekeeper/shared build \
 && pnpm --filter @flow-gatekeeper/worker build

# pnpm 官方 workspace 裁剪：輸出含 production 依賴與 workspace 套件實體的獨立目錄，runtime 不需 pnpm
RUN pnpm --filter @flow-gatekeeper/worker deploy --prod /out

# ---- runtime：只帶裁剪產物，入口為建置產物（dev 工具不進 prod image）----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out .
USER node
CMD ["node", "dist/main.js"]
