# Iron Arena game server (WebSocket + accounts). The client is a static site (npm run build).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# better-sqlite3 is only the local-dev DB; production uses hosted Postgres (DATABASE_URL).
RUN npm ci --omit=dev
COPY src ./src
COPY server ./server
EXPOSE 8080
# Host health checks: GET /healthz
CMD ["node", "server/index.js"]
