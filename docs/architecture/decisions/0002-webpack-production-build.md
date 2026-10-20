# Next.js production build backend

Date: 2026-10-20. Scope: build tooling, not application architecture.

Next.js 16.4.2's default Turbopack production build failed in this managed macOS environment while its CSS/PostCSS subprocess tried to bind a local port (`Operation not permitted`). The failure persisted on a permission-enabled retry. The supported `next build --webpack` path compiled and generated all routes successfully.

The web package therefore uses Webpack for production builds. Development retains Next.js's default Turbopack server. Both remain orchestrated by Turborepo, with the same Next.js App Router, TypeScript, Tailwind/PostCSS and runtime services. This removes the observed local build blocker without changing the declared platform stack.
