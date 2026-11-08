FROM node:26-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY locales ./locales
COPY LICENSE NOTICE ./

# Copied files keep the permissions they had on the host. Make sure the node user can read them.
RUN chmod -R a+rX package.json package-lock.json src public locales LICENSE NOTICE

RUN mkdir /data && chown node:node /data
USER node

ENV HOST=0.0.0.0 DATABASE_PATH=/data/theusual.db
VOLUME /data
EXPOSE 3000

HEALTHCHECK CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/server.js"]
