FROM node:24-alpine AS builder

ARG VITE_FIREBASE_API_KEY="AIzaSyAnTKaXoNN3TNeMeUEZCUMfUQ8yJrqq9aU"
ARG VITE_FIREBASE_AUTH_DOMAIN="chartdb-d235e.firebaseapp.com"
ARG VITE_FIREBASE_PROJECT_ID="chartdb-d235e"
ARG VITE_FIREBASE_STORAGE_BUCKET="chartdb-d235e.firebasestorage.app"
ARG VITE_FIREBASE_MESSAGING_SENDER_ID="527826501748"
ARG VITE_FIREBASE_APP_ID="1:527826501748:web:2cf6fb61d0a9730f78d121"
ARG VITE_OPENAI_API_KEY=""
ARG VITE_OPENAI_API_ENDPOINT=""
ARG VITE_LLM_MODEL_NAME=""
ARG VITE_IS_CHARTDB_IO=false
ARG VITE_APP_URL="https://chartdb.kurdium.com"
ARG VITE_HOST_URL="https://chartdb.kurdium.com"
ARG VITE_HIDE_CHARTDB_CLOUD=false
ARG VITE_DISABLE_ANALYTICS=false

WORKDIR /usr/src/app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN echo "VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY}" > .env && \
    echo "VITE_FIREBASE_AUTH_DOMAIN=${VITE_FIREBASE_AUTH_DOMAIN}" >> .env && \
    echo "VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID}" >> .env && \
    echo "VITE_FIREBASE_STORAGE_BUCKET=${VITE_FIREBASE_STORAGE_BUCKET}" >> .env && \
    echo "VITE_FIREBASE_MESSAGING_SENDER_ID=${VITE_FIREBASE_MESSAGING_SENDER_ID}" >> .env && \
    echo "VITE_FIREBASE_APP_ID=${VITE_FIREBASE_APP_ID}" >> .env && \
    echo "VITE_OPENAI_API_KEY=${VITE_OPENAI_API_KEY}" >> .env && \
    echo "VITE_OPENAI_API_ENDPOINT=${VITE_OPENAI_API_ENDPOINT}" >> .env && \
    echo "VITE_LLM_MODEL_NAME=${VITE_LLM_MODEL_NAME}" >> .env && \
    echo "VITE_IS_CHARTDB_IO=${VITE_IS_CHARTDB_IO}" >> .env && \
    echo "VITE_APP_URL=${VITE_APP_URL}" >> .env && \
    echo "VITE_HOST_URL=${VITE_HOST_URL}" >> .env && \
    echo "VITE_HIDE_CHARTDB_CLOUD=${VITE_HIDE_CHARTDB_CLOUD}" >> .env && \
    echo "VITE_DISABLE_ANALYTICS=${VITE_DISABLE_ANALYTICS}" >> .env

RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

FROM nginx:stable-alpine AS production

COPY --from=builder /usr/src/app/dist /usr/share/nginx/html
COPY ./default.conf.template /etc/nginx/conf.d/default.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]