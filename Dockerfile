FROM node:24.22.3-bookworm-slim
LABEL AUTHOR="yi-ge"
LABEL maintainer="a@wyr.me"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /project

COPY package.json yarn.lock ./
COPY patches ./patches
RUN yarn install --frozen-lockfile --non-interactive --production

COPY src ./src
RUN mkdir -p db

EXPOSE 80

CMD ["node", "src/main.js"]
