# bun runs the .ts sources as-is, so there's still no build stage, and `--production` holds
# for the same reason `--omit=dev` did — typescript is only ever used to type-check.
FROM oven/bun:1-alpine

ENV NODE_ENV=production
WORKDIR /app

# --frozen-lockfile so a stale bun.lock fails the build instead of quietly resolving newer
# versions than anything was tested against.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

USER bun
CMD ["bun", "src/index.ts"]
