# better-sqlite3 est un module natif : image glibc, outils de compilation
# uniquement dans l'étape de construction (utile sur ARM, ex. NAS).
FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    BOT_DATA_DIR=/data
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
CMD ["node", "src/bot.js"]
