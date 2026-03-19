.PHONY: ci check-ts-rules build run-dev repomix collect collect-dry-run collect-no-cache format sync-rule setup

PYTHON ?= python3

check-ts-rules:
	python3 scripts/check_ts_rules.py

# [Intended] CI チェックおよび自動修正を行う
ci:
	npm run check:fix
	npm run format:astro
	npm run check
	npm run format:astro:check
	npm run typecheck
	make check-ts-rules
	npm run test:coverage
	$(MAKE) build

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

collect-dry-run:
	npm run collect-metrics -- --dry-run

collect-no-cache:
	npm run collect-metrics -- --no-cache

sync-rule:
	@sh scripts/sync_rule.sh

setup:
	npm ci
	@printf '#!/bin/sh\nmake sync-rule\n' > .git/hooks/post-merge && chmod +x .git/hooks/post-merge
	@printf '#!/bin/sh\nmake sync-rule\n' > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout
	@echo "setup: git hooks installed"
	@make sync-rule
