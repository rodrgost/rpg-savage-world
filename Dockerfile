FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY functions/package.json functions/package.json

RUN npm ci

COPY . .

RUN npm -w frontend run build && npm -w backend run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY functions/package.json functions/package.json
RUN npm ci --omit=dev

COPY --from=build /app/backend/dist /app/backend/dist
COPY --from=build /app/frontend/dist /app/frontend/dist

CMD ["node", "backend/dist/main.js"]
