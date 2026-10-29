# Only pricing policy, never the full website configuration, enters the runtime image.
FROM node:20-bookworm-slim AS price-policy
WORKDIR /extract
COPY config.json ./config.json
RUN node -e "const c=require('./config.json');if(!Array.isArray(c.services)||!c.services.length)process.exit(1);require('fs').writeFileSync('services.json',JSON.stringify(c.services))"
FROM node:20-bookworm-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY --from=price-policy /extract/services.json ./server/services.json
COPY prototype/security/verified-reservation-handler.cjs prototype/security/receipt-status-handler.cjs ./prototype/security/
USER node
ENV NODE_ENV=production
CMD ["node", "server/index.cjs"]
