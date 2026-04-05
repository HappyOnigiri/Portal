.PHONY: ci check-ts-rules build run-dev repomix collect collect-dry-run collect-no-cache format setup

PYTHON ?= python3

check-ts-rules:
	python3 scripts/check_ts_rules.py

# [Intended] CI チェックおよび自動修正を行う
ci:
	pnpm run check:fix
	pnpm run format:astro
	pnpm run check
	pnpm run format:astro:check
	CI=true pnpm run typecheck
	make check-ts-rules
	pnpm run test:coverage
	CI=true $(MAKE) build

format:
	pnpm run format

run-dev:
	pnpm run dev

build:
	pnpm run build

repomix:
	@mkdir -p tmp/repomix
	pnpm dlx repomix --output tmp/repomix/repomix-output.txt

collect:
	pnpm run collect-metrics
	FETCH_ARTICLES=true pnpm exec astro sync
	pnpm run format

collect-dry-run:
	pnpm run collect-metrics -- --dry-run

collect-no-cache:
	pnpm run collect-metrics -- --no-cache
	pnpm run format

setup:
	curl -fsSL https://raw.githubusercontent.com/HappyOnigiri/ShareSettings/main/SyncRule/run.sh | bash
	corepack enable
	pnpm install --frozen-lockfile
