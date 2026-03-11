.PHONY: ci repomix

ci:
	npm run lint -- --write
	npm run test
	npm run build

repomix:
	@mkdir -p tmp/repomix
	npx repomix --output tmp/repomix/repomix-output.txt
