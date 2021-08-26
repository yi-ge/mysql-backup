FROM node:latest
LABEL AUTHOR="yi-ge"
LABEL maintainer="a@wyr.me"

RUN apt install gcc g++ make

RUN mkdir /project

ADD . /project

WORKDIR /project

RUN yarn

EXPOSE 80

CMD ["npm", "start"]