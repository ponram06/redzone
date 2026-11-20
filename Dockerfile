# RedZone: one container runs the API, the referee, the relayer and the website.
# Build: docker build -t redzone .   Run: see "Running it in production" in README.md.

# 1. Build the website (served by the backend from the same address, so no API URL is baked in).
FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2. The backend.
FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data WEB_DIST=/app/web/dist
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# tsx runs the TypeScript directly, so it is installed too (dev tools like vitest are skipped).
RUN npm ci --omit=dev && npm install --no-save tsx@4 && npm cache clean --force
COPY backend/src ./src
COPY backend/tsconfig.json ./
COPY deployments /app/deployments
COPY --from=web /app/web/dist /app/web/dist
# DATA_DIR must be a persistent disk: robot brains, profiles, owner keys and replays live there.
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
