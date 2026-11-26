FROM node:22-bookworm-slim
ARG KUBECTL_VERSION=v1.37.2
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" && \
    curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256" && \
    cd /tmp && printf '%s  kubectl\n' "$(cat kubectl.sha256)" | sha256sum --check && \
    install -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl kubectl.sha256 && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/runtime-collector.mjs ./scripts/runtime-collector.mjs
COPY scripts/runtime/normalize.mjs ./scripts/runtime/normalize.mjs
COPY backend/src/runtime-normalize.mjs ./backend/src/runtime-normalize.mjs
USER node
CMD ["node", "scripts/runtime-collector.mjs"]
