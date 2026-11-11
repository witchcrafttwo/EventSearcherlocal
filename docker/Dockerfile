# syntax=docker/dockerfile:1
# workerサーバー(Hono/Node) とビルド済みフロント(web/dist) を1コンテナで動かすイメージ。
# ビルドコンテキストはリポジトリ直下。通常は docker/compose.yaml から使う。
#   単体ビルド: docker build -f docker/Dockerfile -t prefecture-events-ai-server:local .
# 除外設定は docker/Dockerfile.dockerignore（.env などの秘密情報はイメージに入れない）。

ARG NODE_VERSION=22

# ---------- 1) build: フロントのビルド + サーバーを1ファイルにバンドル ----------
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app

# npm ci はロックファイルと全ワークスペースの package.json の整合を見るので、全部コピーする
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/infra/package.json packages/infra/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
RUN npm ci --include-workspace-root -w @prefecture-events-ai/web -w @prefecture-events-ai/worker

COPY packages/web/index.html packages/web/tsconfig.json packages/web/
COPY packages/web/public packages/web/public
COPY packages/web/src packages/web/src
COPY packages/worker/src packages/worker/src

# フロントは同一オリジンの /api を叩く（server.ts が API を /api にマウントしているため）。
# Push通知を使う場合は --build-arg VITE_VAPID_PUBLIC_KEY=... を渡す。
ARG VITE_API_BASE_URL=/api
ARG VITE_VAPID_PUBLIC_KEY
RUN npm run build -w @prefecture-events-ai/web

# 実行イメージに tsx などの開発依存を入れないよう、サーバーを esbuild で1ファイルにまとめる。
# npm パッケージはバンドルせず、実行時の node_modules から読む（--packages=external）。
RUN ./node_modules/.bin/esbuild packages/worker/src/server.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --packages=external --outfile=packages/worker/dist/server.mjs

# ---------- 2) runtime: 本番依存だけ入れて node で起動 ----------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    PORT=8787 \
    WEB_DIST=../web/dist
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/infra/package.json packages/infra/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
RUN npm ci --omit=dev -w @prefecture-events-ai/worker && npm cache clean --force

COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=build /app/packages/worker/dist packages/worker/dist

# WEB_DIST(../web/dist) はカレントディレクトリ基準なので、ローカルと同じ packages/worker で起動する
WORKDIR /app/packages/worker
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
