FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/Ichinose520122/fiora-watch"
LABEL org.opencontainers.image.description="Independent watch-together cinema for Fiora"
WORKDIR /app
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
