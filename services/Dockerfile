# Document-check service (Bun + Hono). Build context: services/
FROM oven/bun:1.4.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=deps /app /app
COPY fixtures/scenarios.json ./fixtures/scenarios.json
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/document-check/src/server.ts"]
