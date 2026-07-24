ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

WORKDIR /app

# nur Manifeste zuerst -> Layer-Caching für Dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
