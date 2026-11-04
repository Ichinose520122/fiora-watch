# syntax=docker/dockerfile:1
FROM node:24.22.1-alpine
LABEL org.opencontainers.image.source="https://github.com/Ichinose520122/fiora-watch"
LABEL org.opencontainers.image.description="Independent watch-together cinema for Fiora"
WORKDIR /app
RUN apk add --no-cache python3
ADD --checksum=sha256:e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3 --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp /usr/local/bin/yt-dlp
RUN yt-dlp --version
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY public ./public
RUN mkdir -p /data /library && chown node:node /data /library
USER node
ENV NODE_ENV=production DATA_DIR=/data LIBRARY_DIR=/library PORT=9300
EXPOSE 9300
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:9300/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
