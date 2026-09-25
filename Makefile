STF := node tools/stf-mcp/dist/cli.js
.PHONY: setup build test verify status recall roundtrip gitleaks dev plugin-validate

setup: ## install deps, build the plane, install the secret-scanning git hook
	cd tools/stf-mcp && npm ci
	$(MAKE) build
	git config core.hooksPath .githooks

build:
	cd tools/stf-mcp && npm run build

test: build
	cd tools/stf-mcp && npm test

verify: build   ## re-check every done task's evidence (flips absent → blocked)
	$(STF) verify

status: build
	$(STF) status

recall: build
	$(STF) recall

roundtrip: build ## rebuild the plane from the export and prove it re-renders byte-identically
	$(STF) export
	git diff --exit-code -- .stf/export

gitleaks:
	docker run --rm -v "$(CURDIR):/repo" -w /repo zricethezav/gitleaks:latest git --redact --no-banner --config .gitleaks.toml

dev: build ## run Claude Code on the working-tree plugin (replaces the installed stf for this session)
	claude --plugin-dir tools/stf-mcp

plugin-validate: ## check the plugin manifest and the marketplace entry
	claude plugin validate tools/stf-mcp
	claude plugin validate .
