# Local MinIO source build

Date: 2026-10-20. Scope: development infrastructure only.

The requested MinIO remains the object storage service. The public `minio/minio` Docker Hub repository returned pull access denied, and its Quay counterpart returned 401 during verification. Compose therefore builds the official source release `RELEASE.2025-10-15T17-29-55Z`, pinned to upstream commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`.

The multi-stage Dockerfile runs the resulting service as an unprivileged user, preserves the AGPL license, and limits Go build parallelism. The first build needs internet access and takes longer than pulling a prebuilt image. Docker caches the binary and Go modules for subsequent starts. No third-party mirror is trusted.

Upstream references: [release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z), [source](https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a). This local development image is not a production storage deployment or a claim of ongoing upstream maintenance.
