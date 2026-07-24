ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
FROM ${BUILD_FROM}

# Die HA-Base ist Alpine-basiert und bringt kein Node mit -> Node.js + npm nachinstallieren.
RUN apk add --no-cache nodejs npm

WORKDIR /app

# nur Manifeste zuerst -> Layer-Caching für Dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
