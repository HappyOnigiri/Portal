.PHONY: ci check-ts-rules repomix

check-ts-rules:
	python3 scripts/check_ts_rules.py

ci:
	npm run check
	npm run typecheck
	make check-ts-rules
	npm run test:coverage
	npm run build

repomix:
	@mkdir -p tmp/repomix
	npx repomix --output tmp/repomix/repomix-output.txt
