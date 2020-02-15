FROM node:13.8.0-alpine
LABEL AUTHOR="yi-ge"
LABEL maintainer="a@wyr.me"

RUN apk add --no-cache \
  libstdc++ \
  libgcc \
  openssh-client \
  bash \
  ca-certificates \
  zlib \
  git

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 80

CMD ["npm", "start"]