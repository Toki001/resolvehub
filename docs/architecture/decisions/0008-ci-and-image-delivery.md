# 0008 — Verify untrusted changes separately from image delivery

Status: accepted, milestone 07.

Use a reusable read-only CI workflow for PRs/merge queues and the exact release commit. A separate push-only workflow authorizes protected main/tag ancestry before granting GHCR write permission to its three-component publication matrix. Third-party Actions use inspected official release commit pins. Production infrastructure access is not available to these workflows; an operator promotes digest manifests using the documented deployment configuration.

A single multi-stage Dockerfile shares a frozen dependency/build graph and exposes separate final web/API/worker targets. This avoids duplicated toolchain configuration. Next.js uses monorepo-aware standalone tracing, while pnpm deploy preserves only service production closures and explicit package files. Canonical contract assets and versioned migrations are runtime artifacts. Migration execution is a one-off command with a separate identity, never application startup. Runtime secret files are loaded through an allowlisted Node preload; builds use no application secrets. Unique SHA/run/attempt tags identify every publish attempt; digest references, protected tag creation and restricted registry writers provide the promotion boundary.

Image verification owns disposable infrastructure and separate least-privilege API/worker logins. It starts actual non-root images with read-only roots and checks service readiness, static assets, persisted REST/GraphQL and a BullMQ roundtrip. This supplements, rather than replaces, isolated Jest/NestJS/Testcontainers coverage and migration checks.

The wider dependency audit requires a patched Faker version. One unpatched development-only GraphQL glob dependency has a narrowly scoped expiring exception with negative tests; raw findings stay visible. Available fixes, scope changes and expiry close the security gate. See the release runbook for the advisory and rationale. Remote repository protections, GHCR publication and production promotion need an actual configured remote and are not claimed from local checks.
