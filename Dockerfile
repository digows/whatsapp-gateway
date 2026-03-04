# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install only prod dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Create data directory for session persistence
RUN mkdir -p /app/data/sessions

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data/sessions

EXPOSE 3000

CMD ["node", "dist/index.js"]
