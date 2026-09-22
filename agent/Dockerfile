FROM node:20-bookworm-slim

ARG CANTON_VERSION=3.5.18

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /canton
RUN curl -fsSL -o canton.tar.gz \
    "https://github.com/digital-asset/canton/releases/download/v${CANTON_VERSION}/canton-open-source-${CANTON_VERSION}.tar.gz" \
    && tar -xzf canton.tar.gz --strip-components=1 \
    && rm canton.tar.gz

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --prod=false
COPY tsconfig.json ./
COPY src ./src

ENV CANTON_BIN=/canton/bin/canton
ENTRYPOINT ["node_modules/.bin/tsx", "src/cli.ts"]
