.PHONY: setup install dev build start check generate up down migrate seed bootstrap smoke integration e2e test coverage typecheck eval benchmark

setup:
	pnpm env:setup
	pnpm install --frozen-lockfile

install:
	pnpm install --frozen-lockfile

up:
	pnpm infra:up

down:
	pnpm infra:down

migrate:
	pnpm db:migrate

dev:
	pnpm dev

build:
	pnpm build

start:
	pnpm start

check:
	pnpm check

generate:
	pnpm generate

smoke:
	pnpm smoke

integration:
	pnpm test:integration

e2e:
	pnpm test:e2e

seed:
	pnpm db:seed

bootstrap:
	pnpm db:bootstrap --database resolvehub_synthetic --seed

test:
	pnpm test

coverage:
	pnpm test:coverage

typecheck:
	pnpm typecheck

eval:
	pnpm ai:eval

benchmark:
	pnpm ai:benchmark

.PHONY: workflows images image-smoke
workflows:
	pnpm ci:workflows

images:
	pnpm docker:build

image-smoke:
	pnpm docker:smoke

.PHONY: observability observability-down observability-check performance
observability:
	pnpm observability:up

observability-down:
	pnpm observability:down

observability-check:
	pnpm observability:check

performance:
	pnpm perf:run

.PHONY: dashboard dashboard-tests
dashboard:
	pnpm dashboard:setup

dashboard-tests:
	pnpm test:dashboard
