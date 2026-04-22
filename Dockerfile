FROM node:22-bookworm-slim AS build
WORKDIR /app

ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_MEASUREMENT_ID
ARG VITE_USE_FIREBASE_EMULATORS=false
ARG VITE_OAUTH2_CLIENT_ID
ARG VITE_BACKEND_URL=

ENV VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY}
ENV VITE_FIREBASE_AUTH_DOMAIN=${VITE_FIREBASE_AUTH_DOMAIN}
ENV VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID}
ENV VITE_FIREBASE_STORAGE_BUCKET=${VITE_FIREBASE_STORAGE_BUCKET}
ENV VITE_FIREBASE_MESSAGING_SENDER_ID=${VITE_FIREBASE_MESSAGING_SENDER_ID}
ENV VITE_FIREBASE_APP_ID=${VITE_FIREBASE_APP_ID}
ENV VITE_FIREBASE_MEASUREMENT_ID=${VITE_FIREBASE_MEASUREMENT_ID}
ENV VITE_USE_FIREBASE_EMULATORS=${VITE_USE_FIREBASE_EMULATORS}
ENV VITE_OAUTH2_CLIENT_ID=${VITE_OAUTH2_CLIENT_ID}
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}

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
