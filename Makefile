.PHONY: setup install dev build start check generate up down smoke integration e2e

setup:
	@test -f .env || cp .env.example .env
	pnpm install --frozen-lockfile

install:
	pnpm install --frozen-lockfile

up:
	pnpm infra:up

down:
	pnpm infra:down

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
