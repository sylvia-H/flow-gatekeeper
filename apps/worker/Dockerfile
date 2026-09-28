# apps/worker/Dockerfile — worker 受監督形態的映像（Feature 007；research D1/D2）
#
# build context 為 repo root（pnpm workspace 需要 lockfile 與各套件 manifest）：
#   docker compose --profile demo up -d --build
#
# 憲章 VI：祕密絕不烘入 image——.dockerignore 已把 **/.env 排除在 context 外，
# 祕密於執行時由 compose 的 env_file 注入。
#
# 需 BuildKit（Docker 23+ 預設）：RUN --mount=type=cache 讓 pnpm store 跨次建置、跨三個映像共用，
# store 本身不進任何 image layer。base image 以「tag + digest」雙釘（重建可重現，升版兩者一起改）。

# ---- builder：安裝 worker 建置鏈、建置 contracts/shared/worker、裁剪 production 依賴 ----
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
# corepack 依 root package.json 的 packageManager 取得 lockfile 對應的 pnpm（MUST 先有 package.json 在場，
# 否則 corepack 會退回它自己的預設版本）
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# 1) pnpm fetch 只讀 lockfile 就把全部依賴下載進 store（cache mount）——改任何 app 的 manifest
#    都不會讓下載重來；store 命中時此步僅驗證雜湊。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --store-dir /root/.local/share/pnpm/store

# 2) 再複製全部 importers 的 manifests：frozen lockfile 會核對全部 workspace importers，
#    缺任何一個都會判定 lockfile 過期而失敗（即使下面用 --filter 只裝 worker 建置鏈）。
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/shared/package.json packages/shared/
# --offline：只從 store 連結、不打網路（依賴已由 fetch 備妥）。
# --filter worker...：worker 與其 workspace 依賴（contracts/shared），不裝 web 的 vite／tailwind 等 devDeps；
# 另選 root（flow-gatekeeper）是因 @types/node 只宣告在 root devDependencies，tsc 需要它。
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /root/.local/share/pnpm/store \
      --filter "@flow-gatekeeper/worker..." --filter flow-gatekeeper

# 只複製 worker 建置鏈需要的源碼（api/web 源碼自 008 起也在 context 中，本映像不取用）
COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY apps/worker apps/worker

# 依依賴順序建置：contracts/shared 的 exports 以 default 條件指向 dist，build 後即可被 node 原生解析
# （development 條件指向 src 只給 vite／vitest 用，node runtime 不匹配）
RUN pnpm --filter @flow-gatekeeper/contracts build \
 && pnpm --filter @flow-gatekeeper/shared build \
 && pnpm --filter @flow-gatekeeper/worker build

# pnpm 官方 workspace 裁剪：輸出含 production 依賴與 workspace 套件實體的獨立目錄，runtime 不需 pnpm。
# workspace 套件的 "files": ["dist"] 使 contracts/shared 只帶 dist（不帶 src、*.test.ts）。
# pnpm 10 的 deploy 預設只接受 inject-workspace-packages=true 的 workspace（否則 ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE）；
# 本專案不 inject（dev 期 typecheck／vitest 經 development condition 直接讀 workspace src），故加 --legacy 沿用舊版 deploy。
# legacy deploy 會跑一次解析流程、需要 registry metadata——用 --offline 會因 metadata 快取不在場而失敗
# （ERR_PNPM_NO_OFFLINE_META，2026-09-27 實測重現），故用 --prefer-offline：tarball 仍從 store（cache mount）取，
# 只有 metadata 走網路。解析結果仍以共用 lockfile 為準（log 會印「Shared workspace lockfile detected」）：
# 2026-09-27 以全新 cache mount + --no-cache 建置 api image 實測（pnpm 10.34.5），image 內全部 production 套件與
# pnpm-lock.yaml 的 production 依賴閉包逐一相同（139 個套件名：node_modules/.pnpm 的 149 個目錄扣 2 個 workspace
# 套件、合併 peer 變體與多版本；lockfile 端扣 5 個非 linux-x64 optional），範圍內已有的較新版（ws 8.22.0、bullmq 5.81.5）未被選入。
# 這是單次觀察而非 pnpm 文件保證——升 pnpm 版本時 MUST 以同法重驗（見 README「部署／監督」）。
# worker image 未單獨實測，沿用與 api 相同的 deploy 模式推定同樣依 lockfile。
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @flow-gatekeeper/worker deploy --legacy --prod --prefer-offline --store-dir /root/.local/share/pnpm/store /out

# ---- runtime：只帶裁剪產物，入口為建置產物（dev 工具不進 prod image）----
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out .
USER node
CMD ["node", "dist/main.js"]
