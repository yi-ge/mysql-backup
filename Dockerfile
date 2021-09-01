FROM node:16.8
LABEL AUTHOR="yi-ge"
LABEL maintainer="a@wyr.me"

RUN mkdir /project

ADD . /project

WORKDIR /project

RUN yarn

EXPOSE 80

CMD ["npm", "start"]