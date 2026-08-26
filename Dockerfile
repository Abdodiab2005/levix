# Levix — one container, one volume, nothing else.
#
# Debian slim rather than Alpine on purpose: ffmpeg-static ships a glibc binary
# and would not run on musl, so the thumbnails would silently stop working.

FROM node:24-slim AS deps
WORKDIR /app

# Only the manifests first, so a code change doesn't re-download the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
WORKDIR /app

ENV NODE_ENV=production
# The one environment variable the bot reads: where the volume is mounted.
ENV LEVIX_DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY views ./views
COPY public ./public
COPY app.cjs scheduler.cjs ./

# The database, the WhatsApp session, the memory files, the logs.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3001

# No health check on the HTTP port: the panel answers before WhatsApp is
# linked, so it would report healthy for a bot that is not actually paired.
CMD ["node", "bin/levix.js"]
