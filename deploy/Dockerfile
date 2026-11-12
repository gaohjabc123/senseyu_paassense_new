# 如影 AI 能力开放平台 —— 单容器、单端口（8080）
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
# 运行时没有第三方依赖：只需要 package.json（读取版本号）、服务端、前端产物，
# 以及服务端共用的能力目录 src/lib/capabilities.js
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/lib/capabilities.js ./src/lib/capabilities.js
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
COPY scripts/admin.mjs ./scripts/admin.mjs
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
