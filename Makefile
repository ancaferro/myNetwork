APP      := myNetwork
ELECTRON := ./node_modules/.bin/electron
PIDFILE  := .mynetwork.pid
LOGFILE  := mynetwork.log

.PHONY: all install start stop restart status dist clean help

all: install

## install : install dependencies
install:
	npm install

## start : launch the app in the background
start:
	@if [ -f $(PIDFILE) ] && kill -0 `cat $(PIDFILE)` 2>/dev/null; then \
		echo "$(APP) already running (PID `cat $(PIDFILE)`)"; \
	elif [ ! -x $(ELECTRON) ]; then \
		echo "Electron not installed — run 'make install' first"; \
	else \
		nohup $(ELECTRON) . --no-sandbox > $(LOGFILE) 2>&1 & echo $$! > $(PIDFILE); \
		echo "$(APP) started (PID `cat $(PIDFILE)`) — logs: $(LOGFILE)"; \
	fi

## stop : stop the running app
stop:
	@if [ -f $(PIDFILE) ] && kill -0 `cat $(PIDFILE)` 2>/dev/null; then \
		kill `cat $(PIDFILE)` 2>/dev/null; \
		rm -f $(PIDFILE); \
		echo "$(APP) stopped"; \
	else \
		rm -f $(PIDFILE); \
		echo "$(APP) is not running"; \
	fi

## restart : stop then start
restart: stop start

## status : show whether the app is running
status:
	@if [ -f $(PIDFILE) ] && kill -0 `cat $(PIDFILE)` 2>/dev/null; then \
		echo "$(APP) running (PID `cat $(PIDFILE)`)"; \
	else \
		echo "$(APP) stopped"; \
	fi

## dist : build distributable packages
dist:
	npm run dist

## clean : remove pid/log files
clean:
	rm -f $(PIDFILE) $(LOGFILE)

## help : list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'
