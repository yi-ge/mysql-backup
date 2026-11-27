# syntax=docker/dockerfile:1
FROM node:24.22.3-bookworm-slim
LABEL AUTHOR="yi-ge"
LABEL maintainer="a@wyr.me"

WORKDIR /project

COPY package.json package-lock.json ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

COPY src ./src
RUN mkdir -p db

EXPOSE 80

CMD ["node", "src/main.js"]
