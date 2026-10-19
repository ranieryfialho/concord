# Concord server + built web client in one image.
FROM node:24-bookworm-slim

WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY desktop/package.json desktop/
RUN npm ci --workspace server --workspace client --include=dev

COPY server server
COPY client client
RUN npm run build -w client

ENV NODE_ENV=production PORT=3001 CONCORD_DATA_DIR=/data
VOLUME /data
EXPOSE 3001
CMD ["npx", "tsx", "server/src/index.ts"]
