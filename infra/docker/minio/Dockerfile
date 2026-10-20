# Upstream public image registries no longer serve the community image.
# Build the official release from its immutable upstream Git commit instead.
FROM golang:1.24.8-alpine AS build
WORKDIR /src
ADD https://codeload.github.com/minio/minio/tar.gz/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
ENV CGO_ENABLED=0 GOMAXPROCS=2
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -p 2 -trimpath -ldflags="-s -w" -o /out/minio .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates curl tzdata \
    && addgroup -g 10001 minio \
    && adduser -D -u 10001 -G minio minio \
    && mkdir /data && chown minio:minio /data
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /licenses/minio-LICENSE
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
USER 10001:10001
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
