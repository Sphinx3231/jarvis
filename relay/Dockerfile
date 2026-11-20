# Jarvis relay. Build from the repository root:
#   docker build -f relay/Dockerfile -t jarvis-relay .
#   docker run -d --restart unless-stopped -p 8787:8787 jarvis-relay
# Put TLS in front of it (see relay/README.md); clients must use wss://.
FROM node:22.18-alpine
WORKDIR /app
COPY relay/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay/relay.ts relay/main.ts ./relay/
COPY shared/protocol/protocol.ts shared/protocol/crypto.ts ./shared/protocol/
ENV PORT=8787 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "relay/main.ts"]
