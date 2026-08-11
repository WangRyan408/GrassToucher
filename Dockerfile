# 24 for type stripping: Node runs the .ts sources as-is, so there's no build stage and
# `npm ci --omit=dev` still holds — typescript is only ever used to type-check.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
CMD ["node", "src/index.ts"]
