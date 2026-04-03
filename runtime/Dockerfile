# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Git is required because the Baileys dependency is pulled from GitHub.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
  && git config --global url."https://github.com/".insteadOf "git@github.com:" \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist ./dist

EXPOSE 3000

USER node

CMD ["node", "dist/index.js"]
