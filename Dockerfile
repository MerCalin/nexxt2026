# Staff web app (TanStack Start) as a Bun server. Served on the same origin as the staff API:
# the load balancer routes /api/* to the staff API and everything else here.
FROM oven/bun:1.4.3-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY vite.config.ts tsconfig.json ./
COPY frontend ./frontend
ARG VITE_COGNITO_DOMAIN
ARG VITE_COGNITO_CLIENT_ID
ENV NITRO_PRESET=bun VITE_COGNITO_DOMAIN=$VITE_COGNITO_DOMAIN VITE_COGNITO_CLIENT_ID=$VITE_COGNITO_CLIENT_ID
RUN bunx vite build

FROM oven/bun:1.4.3-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/.output ./.output
USER bun
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
