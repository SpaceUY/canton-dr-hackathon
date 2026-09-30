FROM eclipse-temurin:17-jre-jammy

ARG CANTON_VERSION=3.5.18

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /canton
RUN curl -fsSL -o canton.tar.gz \
    "https://github.com/digital-asset/canton/releases/download/v${CANTON_VERSION}/canton-open-source-${CANTON_VERSION}.tar.gz" \
    && tar -xzf canton.tar.gz --strip-components=1 \
    && rm canton.tar.gz

ENTRYPOINT ["bin/canton"]
