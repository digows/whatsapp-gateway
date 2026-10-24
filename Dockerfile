FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
RUN apt-get update && apt-get install --yes --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.9.1
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY scripts scripts
COPY packages/contracts packages/contracts
COPY packages/chat-adapter packages/chat-adapter
COPY runtime runtime
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @digows/whatsapp-gateway-runtime --prod deploy /production

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ARG GATEWAY_REVISION=unpublished
LABEL org.opencontainers.image.title="WhatsApp Gateway for AI Agents" \
      org.opencontainers.image.source="https://github.com/digows/whatsapp-gateway" \
      org.opencontainers.image.revision="${GATEWAY_REVISION}"
ENV NODE_ENV=production GATEWAY_CONFIG=/run/secrets/gateway.json
WORKDIR /opt/gateway
COPY --from=build --chown=node:node /production/ ./
RUN mkdir -p /data /run/secrets && chown node:node /data
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
