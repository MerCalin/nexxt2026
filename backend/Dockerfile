# Staff API (Bun + Hono). Build context: backend/
FROM oven/bun:1.4.3-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
USER bun
EXPOSE 3001
CMD ["bun", "src/server.ts"]
