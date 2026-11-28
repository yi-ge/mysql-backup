# syntax=docker/dockerfile:1
FROM node:24.22.3-bookworm-slim AS web
WORKDIR /project
COPY package.json package-lock.json ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY vite.config.js ./
COPY web ./web
RUN npm run build

FROM node:24.22.3-bookworm-slim
WORKDIR /project
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates default-mysql-client \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY --from=web /project/dist ./dist
RUN mkdir -p db
EXPOSE 80
CMD ["node", "src/main.js"]
