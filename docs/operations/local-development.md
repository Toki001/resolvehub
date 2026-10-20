# Local development operations

Use `make setup`, `make up`, then `make dev`. Read `.env.example` for required service variables. `make setup` preserves an existing `.env`. Environment errors print invalid field names and exit unsuccessfully without printing their values. Restart processes after environment changes.

| Service       | Local URL or port     | Check                                                          |
| ------------- | --------------------- | -------------------------------------------------------------- |
| Web           | http://localhost:3000 | `/api/health` (liveness), `/api/status` (aggregated UI status) |
| API           | http://127.0.0.1:3001 | `/health/live`, `/health/ready`                                |
| Worker        | http://127.0.0.1:3002 | `/health/live`, `/health/ready`                                |
| PostgreSQL    | 127.0.0.1:5432        | `pg_isready`; API also verifies `vector` is installed          |
| Redis         | 127.0.0.1:6379        | `PING`; AOF enabled, eviction disabled                         |
| MinIO S3      | http://127.0.0.1:9000 | `/minio/health/ready`                                          |
| MinIO console | http://127.0.0.1:9001 | Local infrastructure credentials from `.env`                   |

API/worker readiness returns HTTP 200 with `status: ready`, or 503 with `status: not_ready`. A dependency outage leaves process liveness at HTTP 200, allowing supervisors to distinguish dependency failure from a dead process. PostgreSQL, Redis and HTTP checks have finite timeouts. The API reports only up/down component names, never connection strings or exception details. The web aggregation intentionally returns HTTP 200 with a `not_ready` state when its own route works but dependencies are unavailable; do not use that route as a deployment readiness probe.

`pnpm smoke` checks readiness, submits a system probe with a UUID job ID twice, waits up to ten seconds for the separate worker's result, verifies correlation/completion, then removes the job. It has a thirty-second overall ceiling. The operational queue retains bounded completed/failed jobs; it is not the future application DLQ.

## Common failures

- Docker socket unavailable: start Docker Desktop (or your configured Docker daemon) and retry `pnpm infra:up`.
- First MinIO build is slow: `docker compose --progress plain build minio` shows upstream source/module downloads and compilation. Subsequent builds use the Docker cache. See the source-build decision record for the pinned release.
- Port occupied: stop the other process; API/worker ports are configurable through `.env`. If changing the web port, update its scripts and `WEB_ORIGIN` together. Do not bind this unauthenticated foundation to public interfaces.
- A service is unavailable: Settings shows unavailable/unknown status. Start or recover the corresponding Compose service and use Refresh status. There is no mock fallback.
- Redis restart: BullMQ reconnects and checks readiness again. No domain jobs are accepted in this release.
- Missing pgvector: the extension bootstrap runs only for a new PostgreSQL volume. On an existing local database, apply `infra/docker/postgres-init.sql` using its database owner. Never delete someone else's volume to repair a schema.
- Invalid configuration: fix the named environment fields and restart. No secrets should be added to logs or verification evidence.

Ctrl+C stops application processes and closes database/Redis/worker resources. `docker compose down` stops containers and preserves data. `docker compose down --volumes` is destructive and is never part of normal setup or verification.

Application migrations are not present in milestone 01. Infrastructure extension bootstrap is idempotent SQL, not a migration runner. Migration 01 and clean/repeated/forward-compatible application migration verification belong to the data milestone. MinIO has no application bucket yet; bucket lifecycle arrives with upload contracts.

The basic workflow checks local foundation code on GitHub; it does not publish images, deploy a site, or exercise future milestones. Remote GitHub Actions execution must be verified after pushing to a repository.
