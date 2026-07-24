ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
FROM ${BUILD_FROM}

# Die HA-Base ist Alpine-basiert und bringt kein Node mit -> Node.js + npm nachinstallieren.
# icu-data-full = volle Locale-Daten, sonst fällt de-DE auf US-Format zurück (Datum/Monat/Währung).
RUN apk add --no-cache nodejs npm icu-data-full

WORKDIR /app

# nur Manifeste zuerst -> Layer-Caching für Dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

# Add-on-Version (vom Supervisor als Build-Arg übergeben) in die Laufzeit übernehmen,
# damit sie in der Oberfläche angezeigt werden kann.
ARG BUILD_VERSION
ENV APP_VERSION=${BUILD_VERSION}
ENV NODE_ENV=production
# WICHTIG: Die HA-Base nutzt s6-overlay (/init als Entrypoint) und setzt die Umgebung zurück.
# Ohne dies bekommt der CMD-Prozess KEINE Container-Env – insbesondere fehlt SUPERVISOR_TOKEN,
# was zu HTTP 401 bei allen HA-API-Aufrufen führt. S6_KEEP_ENV=1 reicht die Umgebung durch.
ENV S6_KEEP_ENV=1
CMD ["node", "src/index.js"]
