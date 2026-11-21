# Levelboard – feste Befehle (siehe spec/03-architektur.md)
SHELL := /bin/bash

RUN_ID ?= lokal
GITHUB_REPO ?= specrun-lab/levelboard-$(RUN_ID)
LIVE_DOMAIN ?=
LIVE_URL ?= https://$(RUN_ID).$(LIVE_DOMAIN)
URL ?= http://127.0.0.1:8080
API_URL ?= http://127.0.0.1:8081
NGINX_CONF ?= frontend/nginx.conf

# Wartet höchstens 60 s, bis $(1) antwortet; sonst Logs ausgeben und scheitern.
WAIT = for i in $$(seq 60); do curl -fsS -o /dev/null '$(1)' 2>/dev/null && break; sleep 1; done; curl -fsS -o /dev/null '$(1)' || { echo "Fehler: $(1) antwortet nicht" >&2; tail -n 40 .run/*.log 2>/dev/null; exit 1; }

.PHONY: level1 level2 level3 level4 level5 level6 level7 level8 level9 level10 \
	check down stop-backend restart-backend frontend-build build-backend \
	start-frontend start-nginx start-backend

frontend-build:
	cd frontend && npm ci && npm run build

build-backend:
	cd backend && go build -o bin/levelboard-backend .

start-frontend:
	mkdir -p .run
	( cd frontend && exec ./node_modules/.bin/vite preview ) </dev/null >>.run/frontend.log 2>&1 & echo $$! > .run/frontend.pid

start-nginx:
	mkdir -p .run/nginx-tmp
	nginx -p "$(CURDIR)/" -e .run/nginx-error.log -c $(NGINX_CONF)

start-backend:
	mkdir -p .run
	( exec env LEVELBOARD_DB="$(CURDIR)/.run/levelboard.db" RUN_ID="$(RUN_ID)" backend/bin/levelboard-backend ) </dev/null >>.run/backend.log 2>&1 & echo $$! > .run/backend.pid

stop-backend:
	@if [ -f .run/backend.pid ]; then pid=$$(cat .run/backend.pid); kill $$pid 2>/dev/null; for i in $$(seq 50); do kill -0 $$pid 2>/dev/null || break; sleep 0.1; done; fi; rm -f .run/backend.pid

restart-backend:
	$(MAKE) stop-backend
	$(MAKE) start-backend
	$(call WAIT,$(API_URL)/api/health)
	@echo "Backend neu gestartet (Datenbank erhalten)"

down:
	@for f in .run/frontend.pid .run/nginx.pid .run/backend.pid; do \
	  if [ -f $$f ]; then \
	    pid=$$(cat $$f); \
	    kill $$pid 2>/dev/null; \
	    for i in $$(seq 50); do kill -0 $$pid 2>/dev/null || break; sleep 0.1; done; \
	    rm -f $$f; \
	  fi; \
	done; \
	rm -f .run/level

level1:
	$(MAKE) down
	$(MAKE) frontend-build
	$(MAKE) start-frontend
	echo 1 > .run/level
	$(call WAIT,$(URL)/)
	@echo "Levelboard läuft auf $(URL)"

level2:
	$(MAKE) down
	$(MAKE) frontend-build
	$(MAKE) start-nginx NGINX_CONF=frontend/nginx.conf
	echo 2 > .run/level
	$(call WAIT,$(URL)/)
	@echo "Levelboard läuft auf $(URL)"

level3:
	$(MAKE) down
	$(MAKE) frontend-build
	$(MAKE) build-backend
	rm -f .run/levelboard.db .run/levelboard.db-wal .run/levelboard.db-shm
	$(MAKE) start-nginx NGINX_CONF=frontend/nginx.conf
	$(MAKE) start-backend
	echo 3 > .run/level
	$(call WAIT,$(URL)/)
	$(call WAIT,$(API_URL)/api/health)
	@echo "Levelboard läuft auf $(URL)"
	@echo "Backend läuft auf $(API_URL)"

level4:
	$(MAKE) down
	$(MAKE) frontend-build
	$(MAKE) build-backend
	rm -f .run/levelboard.db .run/levelboard.db-wal .run/levelboard.db-shm
	$(MAKE) start-nginx NGINX_CONF=frontend/nginx.conf
	$(MAKE) start-backend
	echo 4 > .run/level
	$(call WAIT,$(URL)/)
	$(call WAIT,$(API_URL)/api/health)
	@echo "Levelboard läuft auf $(URL)"
	@echo "Backend läuft auf $(API_URL)"
	@echo "Datenbank: .run/levelboard.db"

level5:
	$(MAKE) down
	$(MAKE) frontend-build
	$(MAKE) build-backend
	rm -f .run/levelboard.db .run/levelboard.db-wal .run/levelboard.db-shm
	echo '{"source":"api"}' > frontend/dist/config.json
	$(MAKE) start-nginx NGINX_CONF=frontend/nginx-api.conf
	$(MAKE) start-backend
	echo 5 > .run/level
	$(call WAIT,$(URL)/api/health)
	@echo "Levelboard läuft auf $(URL) (Quelle: Backend)"
	@echo "Backend läuft auf $(API_URL)"
	@echo "Datenbank: .run/levelboard.db"

level6:
	$(MAKE) level5
	echo 6 > .run/level
	@echo "Repo: https://github.com/$(GITHUB_REPO)"

level7:
	$(MAKE) level6
	echo 7 > .run/level
	@echo "Images: ghcr.io/$(GITHUB_REPO)-frontend und ghcr.io/$(GITHUB_REPO)-backend"

level8:
	$(MAKE) level7
	echo 8 > .run/level
	@echo "Live: $(LIVE_URL)"

level9:
	$(MAKE) level8
	echo 9 > .run/level
	@echo "Live-Prüfung gegen $(LIVE_URL)"

level10:
	$(MAKE) level9
	echo 10 > .run/level
	@echo "Abschlussbericht: $(LIVE_URL)"

check:
	@N=$$(cat .run/level 2>/dev/null || echo 10); \
	rm -f checks/.out/loadtest.json; \
	if [ ! -d checks/node_modules ]; then (cd checks && npm ci); fi; \
	(cd checks && npx playwright install chromium); \
	FILES=$$(for i in $$(seq 1 $$N); do printf 'tests/level%s.spec.ts ' $$i; done); \
	STATUS=0; \
	(cd checks && BASE_URL=$(URL) API_URL=$(API_URL) GITHUB_REPO=$(GITHUB_REPO) RUN_ID=$(RUN_ID) LIVE_URL=$(LIVE_URL) npx playwright test $$FILES) || STATUS=1; \
	ENVS="GITHUB_REPO=$(GITHUB_REPO) RUN_ID=$(RUN_ID) API_URL=$(API_URL)"; \
	if [ $$N -ge 5 ]; then ENVS="$$ENVS REPORT_API=1"; fi; \
	if [ $$N -ge 9 ]; then ENVS="$$ENVS REPORT_LIVE=1 LIVE_URL=$(LIVE_URL)"; fi; \
	WR=0; env $$ENVS node checks/write-results.mjs $$(seq 1 $$N) || WR=1; \
	if [ $$WR -ne 0 ]; then STATUS=1; fi; \
	if [ $$N -ge 10 ] && [ $$WR -eq 0 ]; then (cd checks && LIVE_URL=$(LIVE_URL) RUN_ID=$(RUN_ID) npx playwright test tests/live-report.spec.ts --reporter=list) || STATUS=1; fi; \
	exit $$STATUS
