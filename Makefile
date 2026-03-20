.PHONY: ci check-ts-rules build run-dev repomix collect collect-dry-run collect-no-cache format setup

PYTHON ?= python3

check-ts-rules:
	python3 scripts/check_ts_rules.py

# [Intended] CI チェックおよび自動修正を行う
ci:
	npm run check:fix
	npm run format:astro
	npm run check
	npm run format:astro:check
	CI=true npm run typecheck
	make check-ts-rules
	npm run test:coverage
	CI=true $(MAKE) build

format:
	npm run format

run-dev:
	npm run dev

build:
	npm run build

repomix:
	@mkdir -p tmp/repomix
	npx repomix --output tmp/repomix/repomix-output.txt

collect:
	npm run collect-metrics
	FETCH_ZENN=true npx astro sync

collect-dry-run:
	npm run collect-metrics -- --dry-run

collect-no-cache:
	npm run collect-metrics -- --no-cache

setup:
	curl -fsSL https://raw.githubusercontent.com/HappyOnigiri/ShareSettings/main/SyncRule/run.sh | bash
	npm ci
