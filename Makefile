.PHONY: ci check-ts-rules build run-dev repomix collect collect-dry-run format

check-ts-rules:
	python3 scripts/check_ts_rules.py

ci:
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
