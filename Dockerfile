FROM oven/bun:1 AS base

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
COPY packages/agent-bridge/package.json packages/agent-bridge/
COPY packages/doc-core/package.json packages/doc-core/
COPY packages/doc-editor/package.json packages/doc-editor/
COPY packages/doc-server/package.json packages/doc-server/
COPY packages/doc-store-sqlite/package.json packages/doc-store-sqlite/
COPY apps/proof-example/package.json apps/proof-example/

# Skip better-sqlite3 native build — we use bun:sqlite instead
RUN bun install --ignore-scripts

# Copy source
COPY . .

# Build frontend
RUN bun run build

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["bun", "run", "server/index.ts"]
