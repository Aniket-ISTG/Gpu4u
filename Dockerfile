FROM node:24-slim

WORKDIR /app

# Install dependencies first so Docker can cache them.
COPY package.json ./
COPY payment-engine/package.json payment-engine/package-lock.json payment-engine/
COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm ci --prefix payment-engine && npm ci --prefix frontend

COPY . .

# NEXT_PUBLIC_* values are baked into the web app at build time, so the build needs this one.
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
RUN npm run build

ENV NODE_ENV=production
# The host sets PORT. Only the web app is public; the payment service stays on 127.0.0.1.
EXPOSE 3000
CMD ["node", "start.js"]
