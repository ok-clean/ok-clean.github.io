FROM node:20-bookworm-slim
WORKDIR /app
COPY server/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY prototype/security/verified-reservation-handler.cjs prototype/security/receipt-status-handler.cjs ./prototype/security/
USER node
ENV NODE_ENV=production
CMD ["node", "server/index.cjs"]
