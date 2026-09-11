# Build from the repository root; Dockerfile.dockerignore is deny-by-default.
# Official multi-platform image digests checked against Docker Hub 2026-09-11.
FROM rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97 AS bridge
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY fixtures/hello.txt ./fixtures/hello.txt
RUN cargo build --locked --release --bin native-bridge --jobs 2

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS javascript-dependencies
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM javascript-dependencies AS server
COPY scripts ./scripts
COPY deploy/agent-demo/build.mjs ./deploy/agent-demo/build.mjs
RUN node deploy/agent-demo/build.mjs

FROM javascript-dependencies AS browser
COPY ui/agent-demo/package.json ui/agent-demo/package-lock.json ./ui/agent-demo/
RUN npm --prefix ui/agent-demo ci --no-audit --no-fund
COPY scripts ./scripts
COPY ui/agent-demo/index.html ui/agent-demo/tsconfig.json ui/agent-demo/vite.config.ts ./ui/agent-demo/
COPY ui/agent-demo/src ./ui/agent-demo/src
RUN npm --prefix ui/agent-demo run build

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
ENV NODE_ENV=production M2M_NATIVE_BRIDGE=/usr/local/bin/native-bridge
WORKDIR /app
COPY --from=bridge /build/target/release/native-bridge /usr/local/bin/native-bridge
COPY --from=bridge /etc/ssl/certs /etc/ssl/certs
COPY --from=dependencies /app/package.json /app/package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=server /build/dist/agent-demo/scripts ./scripts
COPY --from=browser /build/ui/agent-demo/dist ./ui
# The mounted volume must be separately initialized for uid/gid 1000.
# This image never creates keys, provisions identities, or funds on boot.
USER 1000:1000
STOPSIGNAL SIGTERM
CMD ["node", "/app/scripts/agent-demo-server.js", "--config", "/data/m2m/host.json"]
