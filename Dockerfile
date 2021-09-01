FROM node:16.3-alpine3.12
LABEL AUTHOR="yi-ge"
LABEL maintainer="a@wyr.me"

RUN apk add --no-cache \
  bash \
  ca-certificates \
  git

RUN mkdir /project

ADD . /project

WORKDIR /project

RUN yarn

EXPOSE 80

CMD ["npm", "start"]