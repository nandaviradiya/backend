# ── Stage 1: Build ──────────────────────────────────────────
FROM node:20-slim AS builder
RUN apt-get update -y && apt-get install -y openssl ca-certificates
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────
FROM node:20-slim AS production
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

EXPOSE 3000

# Start application
CMD ["node", "dist/main"]

