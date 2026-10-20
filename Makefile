.PHONY: setup install dev build start check generate up down migrate smoke integration e2e

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
