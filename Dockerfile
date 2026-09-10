# Cross-region Fly Machines image for the m2m channel PoC.
#
# The Rust executable and the TypeScript Sui adapter are built from the locked
# manifests. Runtime credentials and the state directory are supplied by the
# Fly runner; no wallet, endpoint key, journal, or .m2m directory is copied
# into this image.

FROM rust:1.97.1-bookworm AS rust-builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY fixtures ./fixtures
RUN cargo build --locked --release --bin m2m

FROM node:22.23.2-bookworm-slim AS node-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22.23.2-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/m2m /state \
    && chmod 700 /run/m2m /state

COPY --from=rust-builder /app/target/release/m2m /usr/local/bin/m2m
COPY --from=node-dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY fixtures ./fixtures

RUN chmod 755 /usr/local/bin/m2m

# The runner overrides this with `sleep infinity` while it initializes the
# machine, then uses `fly machine exec` to run the provider or buyer process.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
